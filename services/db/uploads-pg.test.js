// ---------------------------------------------------------------------------
// Contract tests for the PostgreSQL upload store (mongo2pg S1).
//
// These assert the OBSERVABLE behaviour the rest of the app depends on, which
// is defined by the Mongo implementation this replaces. Where a behaviour is
// load-bearing at a specific call site, the test names it, so a future change
// that breaks it fails with an explanation rather than a diff.
//
// Runs against a real PostgreSQL (see utils/testing/pg.js). If none is
// reachable the whole suite SKIPS — the default-path CI gate must never depend
// on a database being available.
// ---------------------------------------------------------------------------

const pgTesting = require('../../utils/testing/pg')

// Decide skip-vs-run from CONFIGURATION, synchronously, so the choice is made
// at collection time and eslint-plugin-jest can see the assertions.
//
// Deliberate semantics: PG *not configured* => the suite is SKIPPED (the
// default CI gate must not depend on a database). PG *configured but broken*
// => the suite FAILS in beforeAll. A probe-and-silently-pass wrapper would have
// hidden exactly the case worth knowing about.
const pgConfigured = pgTesting.isConfigured()
// Skip at the DESCRIBE level so every inner block is a literal `test(...)`:
// eslint-plugin-jest only recognises literal test/it calls, and assertions
// inside an aliased wrapper read as standalone expects.
const describePg = pgConfigured ? describe : describe.skip

let db

beforeAll(async () => {
  if (!pgConfigured) { return }
  process.env.UPLOADS_DB = 'pg'
  await pgTesting.connect()
  db = require('./uploads-pg')
})

afterAll(async () => {
  if (!pgConfigured) { return }
  await pgTesting.disconnect()
  delete process.env.UPLOADS_DB
})

beforeEach(async () => {
  if (!pgConfigured) { return }
  await pgTesting.truncate()
})

// ---------------------------------------------------------------------------
// status enum
// ---------------------------------------------------------------------------

describePg('status enum', () => {
  test('is byte-identical to the Mongo backend (wire values persisted in DB rows and queues)', async () => {
    const mongoStatus = require('./mongo').status
    expect(db.status).toEqual(mongoStatus)
    expect(db.status).toEqual({ WAITING: 0, UPLOADED: 10, INGESTED: 20, FAILED: 30, DUPLICATE: 31, CHECKSUM: 32 })
  })
})

// ---------------------------------------------------------------------------
// generateUpload
// ---------------------------------------------------------------------------

describePg('generateUpload', () => {
  test('returns the {id,path,uploadSource,signingSource} contract', async () => {
    const result = await db.generateUpload({
      streamId: 'stream1234567890',
      userId: 'user-1',
      timestamp: new Date().toISOString(),
      originalFilename: 'recording.flac',
      fileExtension: 'flac',
      checksum: 'abc123'
    })
    expect(Object.keys(result).sort()).toEqual(['id', 'path', 'signingSource', 'uploadSource'])
    expect(result.path).toBe(`stream1234567890/${result.id}.flac`)
  })

  test('generates a 24-hex ObjectId-shaped id, NEVER a UUID (the S3 key is derived from it)', async () => {
    for (let i = 0; i < 50; i++) {
      const result = await db.generateUpload({
        streamId: 's', fileExtension: 'flac', timestamp: new Date().toISOString()
      })
      expect(result.id).toMatch(/^[0-9a-f]{24}$/)
      expect(result.id).not.toMatch(/-/) // a UUID would have dashes
    }
  })

  test('persists ingestion_result as {"segments":[]} rather than NULL (100% of live docs carry it)', async () => {
    const { id } = await db.generateUpload({ streamId: 's', fileExtension: 'flac', timestamp: new Date().toISOString() })
    const row = await pgTesting.rawRow(id)
    expect(row.ingestion_result).toEqual({ segments: [] })
  })

  test('defaults status to WAITING', async () => {
    const { id } = await db.generateUpload({ streamId: 's', fileExtension: 'flac', timestamp: new Date().toISOString() })
    const upload = await db.getUpload(id)
    expect(upload.status).toBe(db.status.WAITING)
  })

  test('normalises laneTier exactly like the Mongo path (whitelist, lowercased, else standard)', async () => {
    const cases = [
      ['express', 'express'], ['priority', 'priority'], ['standard', 'standard'],
      ['EXPRESS', 'express'], ['Priority', 'priority'],
      ['', 'standard'], [undefined, 'standard'], [null, 'standard'],
      ['nonsense', 'standard'], ['expres', 'standard'], [' express', 'standard'],
      [123, 'standard'], [{}, 'standard'], [[], 'standard']
    ]
    for (const [input, expected] of cases) {
      const { id } = await db.generateUpload({
        streamId: 's', fileExtension: 'flac', timestamp: new Date().toISOString(), laneTier: input
      })
      const upload = await db.getUpload(id)
      expect([input, upload.laneTier]).toEqual([input, expected])
    }
  })

  test('keeps sampleRate/targetBitrate when supplied (0 live rows, but live code paths)', async () => {
    const { id } = await db.generateUpload({
      streamId: 's', fileExtension: 'opus', timestamp: new Date().toISOString(), sampleRate: 48000, targetBitrate: 128
    })
    const upload = await db.getUpload(id)
    expect(upload.sampleRate).toBe(48000)
    expect(upload.targetBitrate).toBe(128)
  })
})

// ---------------------------------------------------------------------------
// getUpload
// ---------------------------------------------------------------------------

describePg('getUpload', () => {
  test('sets BOTH id and _id (routes/uploads.js interpolates upload._id into a fallback S3 key)', async () => {
    const id = await pgTesting.insertUpload({ streamId: 'streamA', originalFilename: 'x.flac' })
    const upload = await db.getUpload(id)
    expect(upload.id).toBe(id)
    expect(upload._id).toBe(id)
    // the exact expression used at routes/uploads.js:440
    const fallbackKey = `${upload.streamId}/${upload._id}.${(upload.originalFilename || '').split('.').pop().toLowerCase()}`
    expect(fallbackKey).toBe(`streamA/${id}.flac`)
    expect(fallbackKey).not.toContain('undefined')
  })

  test('resolves null for a well-formed id with no row (assertUploadStatusAccess tests falsy)', async () => {
    const upload = await db.getUpload('a'.repeat(24))
    expect(upload).toBeNull()
  })

  test('rejects EmptyResultError with the byte-identical message for a malformed id (CastError equivalence)', async () => {
    const { EmptyResultError } = require('@rfcx/http-utils')
    for (const bad of ['not-an-id', '', '   ', 'zzzz', 'a'.repeat(23), 'a'.repeat(25), 'ghijklmnopqrstuvwxyz1234']) {
      await expect(db.getUpload(bad)).rejects.toThrow(EmptyResultError)
      await expect(db.getUpload(bad)).rejects.toThrow('Upload with given id not found.')
    }
  })

  test('a 23-char id does not match a 24-char row (char(24) padding cannot cause a false hit)', async () => {
    const id = await pgTesting.insertUpload({})
    expect(await db.getUpload(id)).not.toBeNull()
    await expect(db.getUpload(id.slice(0, 23))).rejects.toThrow('Upload with given id not found.')
  })

  test('returns camelCase fields', async () => {
    const id = await pgTesting.insertUpload({ projectId: 'p1', originalFilename: 'a.flac', checksum: 'sum' })
    const upload = await db.getUpload(id)
    expect(upload.projectId).toBe('p1')
    expect(upload.originalFilename).toBe('a.flac')
    expect(upload.checksum).toBe('sum')
    expect(upload.stream_id).toBeUndefined()
    expect(upload.original_filename).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// updateUploadStatus
// ---------------------------------------------------------------------------

describePg('updateUploadStatus', () => {
  test('throws SYNCHRONOUSLY on an invalid status (mongo.js throws before returning a promise)', async () => {
    const id = await pgTesting.insertUpload({})
    expect(() => db.updateUploadStatus(id, 99)).toThrow('Invalid status')
    expect(() => db.updateUploadStatus(id, -1)).toThrow('Invalid status')
    expect(() => db.updateUploadStatus(id, null)).toThrow('Invalid status')
  })

  test('rejects "Upload does not exist" when no row matches', async () => {
    await expect(db.updateUploadStatus('a'.repeat(24), db.status.UPLOADED)).rejects.toThrow('Upload does not exist')
  })

  test('sets the status and bumps updated_at', async () => {
    const old = new Date(Date.now() - 60000)
    const id = await pgTesting.insertUpload({ updatedAt: old })
    await db.updateUploadStatus(id, db.status.INGESTED)
    const upload = await db.getUpload(id)
    expect(upload.status).toBe(db.status.INGESTED)
    expect(new Date(upload.updatedAt).getTime()).toBeGreaterThan(old.getTime())
  })

  test('sets failureMessage when supplied', async () => {
    const id = await pgTesting.insertUpload({})
    await db.updateUploadStatus(id, db.status.FAILED, 'boom')
    expect((await db.getUpload(id)).failureMessage).toBe('boom')
  })

  test('CLEARS failureMessage on UPLOADED/INGESTED when null is passed', async () => {
    for (const statusNumber of [db.status.UPLOADED, db.status.INGESTED]) {
      const id = await pgTesting.insertUpload({ failureMessage: 'previous failure' })
      await db.updateUploadStatus(id, statusNumber, null)
      expect((await db.getUpload(id)).failureMessage).toBeUndefined()
    }
  })

  test('PRESERVES failureMessage on a non-UPLOADED/INGESTED status when null is passed', async () => {
    const id = await pgTesting.insertUpload({ failureMessage: 'previous failure' })
    await db.updateUploadStatus(id, db.status.DUPLICATE, null)
    expect((await db.getUpload(id)).failureMessage).toBe('previous failure')
  })

  test('only overwrites ingestionResult when one is provided', async () => {
    const id = await pgTesting.insertUpload({})
    const result = { streamSourceFileId: 'ssf-1', segments: [{ id: 'seg1', path: 'p' }] }
    await db.updateUploadStatus(id, db.status.INGESTED, null, result)
    expect((await db.getUpload(id)).ingestionResult).toEqual(result)
    // a later flip without one must not wipe it
    await db.updateUploadStatus(id, db.status.FAILED, 'later failure')
    expect((await db.getUpload(id)).ingestionResult).toEqual(result)
  })

  test('stores ingestionResult segments WITHOUT any $oid/_id leakage (backfill divergence 1)', async () => {
    const id = await pgTesting.insertUpload({})
    await db.updateUploadStatus(id, db.status.INGESTED, null, {
      streamSourceFileId: 'ssf', segments: [{ id: 'seg1', start: '2026-01-01T00:00:00Z', path: 'a/b.flac' }]
    })
    const row = await pgTesting.rawRow(id)
    const serialised = JSON.stringify(row.ingestion_result)
    expect(serialised).not.toContain('$oid')
    expect(row.ingestion_result.segments[0]._id).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// multipart trio
// ---------------------------------------------------------------------------

describePg('multipart', () => {
  test('setUploadMultipart stores the subdocument the routes read back', async () => {
    const id = await pgTesting.insertUpload({})
    await db.setUploadMultipart(id, { uploadId: 'mp-1', partSizeBytes: 64, partCount: 3 })
    const upload = await db.getUpload(id)
    expect(upload.multipart.uploadId).toBe('mp-1')
    expect(upload.multipart.partSizeBytes).toBe(64)
    expect(upload.multipart.partCount).toBe(3)
  })

  test('completed/aborted MERGE into the existing subdocument (mongoose $set path semantics)', async () => {
    const id = await pgTesting.insertUpload({})
    await db.setUploadMultipart(id, { uploadId: 'mp-1', partSizeBytes: 64, partCount: 3 })
    await db.setUploadMultipartCompleted(id)
    let upload = await db.getUpload(id)
    expect(upload.multipart.uploadId).toBe('mp-1') // not clobbered
    expect(upload.multipart.completedAt).toBeTruthy()

    await db.setUploadMultipartAborted(id)
    upload = await db.getUpload(id)
    expect(upload.multipart.uploadId).toBe('mp-1')
    expect(upload.multipart.completedAt).toBeTruthy()
    expect(upload.multipart.abortedAt).toBeTruthy()
  })

  test('completed/aborted create the subdocument when multipart is absent (mongoose $set creates it)', async () => {
    const id = await pgTesting.insertUpload({})
    await db.setUploadMultipartCompleted(id)
    expect((await db.getUpload(id)).multipart.completedAt).toBeTruthy()
  })

  test('single-PUT uploads keep multipart NULL/undefined so the route guard rejects them', async () => {
    const { id } = await db.generateUpload({ streamId: 's', fileExtension: 'flac', timestamp: new Date().toISOString() })
    const upload = await db.getUpload(id)
    // the exact guard at routes/uploads.js:431
    expect(!upload.multipart || !upload.multipart.uploadId).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// counts + quota + health-check
// ---------------------------------------------------------------------------

describePg('counts and quota', () => {
  test('getUploadFailedCount / getUploadDuplicateCount return NUMBERS (pg returns bigint as string)', async () => {
    await pgTesting.insertUpload({ status: db.status.FAILED })
    await pgTesting.insertUpload({ status: db.status.FAILED })
    await pgTesting.insertUpload({ status: db.status.DUPLICATE })
    const failed = await db.getUploadFailedCount()
    const duplicate = await db.getUploadDuplicateCount()
    expect(failed).toBe(2)
    expect(duplicate).toBe(1)
    expect(typeof failed).toBe('number') // a string would break the prometheus gauge
    expect(typeof duplicate).toBe('number')
  })

  test('getPendingProjectDuration sums only WAITING/UPLOADED with duration > 0', async () => {
    await pgTesting.insertUpload({ projectId: 'p1', status: db.status.WAITING, duration: 100 })
    await pgTesting.insertUpload({ projectId: 'p1', status: db.status.UPLOADED, duration: 50 })
    await pgTesting.insertUpload({ projectId: 'p1', status: db.status.INGESTED, duration: 999 }) // excluded
    await pgTesting.insertUpload({ projectId: 'p1', status: db.status.WAITING, duration: 0 }) // excluded
    await pgTesting.insertUpload({ projectId: 'p2', status: db.status.WAITING, duration: 7 }) // other project
    const total = await db.getPendingProjectDuration('p1')
    expect(total).toBe(150)
    expect(typeof total).toBe('number')
  })

  test('getPendingProjectDuration returns 0 for a falsy projectId without querying', async () => {
    expect(await db.getPendingProjectDuration(null)).toBe(0)
    expect(await db.getPendingProjectDuration(undefined)).toBe(0)
    expect(await db.getPendingProjectDuration('')).toBe(0)
  })

  test('getPendingProjectDuration returns 0 for an unknown project', async () => {
    expect(await db.getPendingProjectDuration('nobody')).toBe(0)
  })

  test('getOrCreateHealthCheck is an idempotent upsert (the API readinessProbe calls this)', async () => {
    const first = await db.getOrCreateHealthCheck()
    expect(first.event).toBe('check')
    const second = await db.getOrCreateHealthCheck()
    expect(second.event).toBe('check')
    const rows = await pgTesting.getPool().query('SELECT COUNT(*)::int AS c FROM ingest.health_check')
    expect(rows.rows[0].c).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// cleanup seam
// ---------------------------------------------------------------------------

describePg('cleanup seam', () => {
  const old = () => new Date(Date.now() - 86400000)

  test('findCleanupCandidates applies every predicate the Mongo query applied', async () => {
    const cutoff = new Date(Date.now() - 3600000)
    const wanted = await pgTesting.insertUpload({ status: 20, updatedAt: old(), checksum: 'c', originalFilename: 'f.flac' })
    await pgTesting.insertUpload({ status: 0, updatedAt: old(), checksum: 'c', originalFilename: 'f.flac' }) // wrong status
    await pgTesting.insertUpload({ status: 20, updatedAt: new Date(), checksum: 'c', originalFilename: 'f.flac' }) // too recent
    await pgTesting.insertUpload({ status: 20, updatedAt: old(), checksum: null, originalFilename: 'f.flac' }) // no checksum
    await pgTesting.insertUpload({ status: 20, updatedAt: old(), checksum: 'c', originalFilename: null }) // no filename
    await pgTesting.insertUpload({ status: 20, updatedAt: old(), checksum: 'c', originalFilename: 'f.flac', uploadSourceDeletedAt: new Date() }) // already deleted

    const found = await db.findCleanupCandidates({ statuses: [20, 31], cutoff, batchSize: 100 })
    expect(found.map(u => u.id)).toEqual([wanted])
  })

  test('findCleanupCandidates honours batchSize and orders by updated_at ASC', async () => {
    const cutoff = new Date(Date.now() - 3600000)
    const older = await pgTesting.insertUpload({ status: 20, updatedAt: new Date(Date.now() - 200000000), checksum: 'c', originalFilename: 'f.flac' })
    await pgTesting.insertUpload({ status: 20, updatedAt: old(), checksum: 'c', originalFilename: 'f.flac' })
    const found = await db.findCleanupCandidates({ statuses: [20], cutoff, batchSize: 1 })
    expect(found).toHaveLength(1)
    expect(found[0].id).toBe(older)
  })

  test('candidates expose _id (upload-source-cleanup builds keys and logs from it)', async () => {
    const cutoff = new Date(Date.now() - 3600000)
    const id = await pgTesting.insertUpload({ status: 20, updatedAt: old(), checksum: 'c', originalFilename: 'f.flac' })
    const [candidate] = await db.findCleanupCandidates({ statuses: [20], cutoff, batchSize: 10 })
    expect(candidate._id).toBe(id)
  })

  test('markUploadSourceDeleted is idempotent — a second pass cannot overwrite the first record', async () => {
    const id = await pgTesting.insertUpload({ status: 20 })
    await db.markUploadSourceDeleted(id, 'deleted bucket/key')
    const first = await pgTesting.rawRow(id)
    expect(first.upload_source_cleanup_message).toBe('deleted bucket/key')

    await db.markUploadSourceDeleted(id, 'SECOND PASS')
    const second = await pgTesting.rawRow(id)
    expect(second.upload_source_cleanup_message).toBe('deleted bucket/key')
    expect(second.upload_source_deleted_at.getTime()).toBe(first.upload_source_deleted_at.getTime())
  })
})
