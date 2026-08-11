// ---------------------------------------------------------------------------
// Mongo <-> PostgreSQL PARITY / FUZZ harness (mongo2pg S1).
//
// Standing lesson behind this file: when correctness depends on two
// independent implementations deriving the SAME value, FUZZ the derivation —
// do not sample it. Two prior incidents in this codebase (the fractional-ms
// token defect, the external_id divergence) each passed a single hand-picked
// example and failed in production on the tail of the input distribution.
//
// So: randomised inputs are pushed through BOTH backends and their observable
// outputs compared field by field. Both engines run for real — Mongo via
// mongodb-memory-server, PG via utils/testing/pg — because the point is to
// catch places where the ENGINES differ, which a mocked twin cannot show.
//
// If either engine is unavailable the suite SKIPS (the default CI gate must
// not depend on a database being present).
// ---------------------------------------------------------------------------

const mongoTesting = require('../../utils/testing/db')
const pgTesting = require('../../utils/testing/pg')

const SEED = Number(process.env.PARITY_SEED || 20260811)
const ITERATIONS = Number(process.env.PARITY_ITERATIONS || 200)

/** Deterministic PRNG so a failure is reproducible from the printed seed. */
function makeRandom (seed) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
}

// See uploads-pg.test.js: skip-vs-run is decided from CONFIGURATION,
// synchronously, so a configured-but-broken database FAILS rather than being
// silently skipped, and eslint-plugin-jest can see the assertions.
const pgConfigured = pgTesting.isConfigured()
// Skip at the DESCRIBE level so every inner block is a literal `test(...)`:
// eslint-plugin-jest only recognises literal test/it calls, and assertions
// inside an aliased wrapper read as standalone expects.
const describePg = pgConfigured ? describe : describe.skip

let mongoDb
let pgDb

// STRING (and empty/absent) laneTier values only. That is the real contract:
// the sole production caller is deriveLaneTier() in routes/uploads.js, which
// coerces with String() and whitelists before this layer is reached, and the
// route validator declares laneTier `.optional().toString()`.
//
// Non-string values are covered separately in the 'latent divergence' test
// below rather than here, because the Mongo implementation THROWS on them
// (a pre-existing latent defect, unreachable in production) and mixing that
// into the parity fuzz would assert bug-for-bug compatibility as a goal.
const LANE_TIER_INPUTS = [
  'express', 'priority', 'standard', 'EXPRESS', 'Priority', 'StAnDaRd',
  '', ' ', 'expres', 'nonsense', 'express ', ' express', 'null', 'undefined',
  undefined, null
]

const EXTENSIONS = ['flac', 'wav', 'mp3', 'opus', 'FLAC', 'ogg']

function randomFrom (rand, list) {
  return list[Math.floor(rand() * list.length) % list.length]
}

function randomStreamId (rand) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  for (let i = 0; i < 12; i++) { out += chars[Math.floor(rand() * chars.length) % chars.length] }
  return out
}

beforeAll(async () => {
  if (!pgConfigured) { return }
  await mongoTesting.connect()
  await pgTesting.connect()
  mongoDb = require('./mongo')
  pgDb = require('./uploads-pg')
}, 120000)

afterAll(async () => {
  if (!pgConfigured) { return }
  await pgTesting.disconnect()
  await mongoTesting.disconnect()
})

beforeEach(async () => {
  if (!pgConfigured) { return }
  await pgTesting.truncate()
  await mongoTesting.truncate()
})

// ---------------------------------------------------------------------------

describePg('parity: generateUpload', () => {
  test(`produces identical observable output across ${ITERATIONS} randomised inputs (seed ${SEED})`, async () => {
    const rand = makeRandom(SEED)
    const mismatches = []

    for (let i = 0; i < ITERATIONS; i++) {
      const opts = {
        streamId: randomStreamId(rand),
        userId: `user-${Math.floor(rand() * 1000)}`,
        timestamp: new Date(Date.UTC(2026, 0, 1 + Math.floor(rand() * 300), Math.floor(rand() * 24))).toISOString(),
        originalFilename: `rec-${Math.floor(rand() * 10000)}.flac`,
        fileExtension: randomFrom(rand, EXTENSIONS),
        checksum: `sum-${Math.floor(rand() * 100000)}`,
        projectId: rand() > 0.3 ? `project-${Math.floor(rand() * 50)}` : undefined,
        duration: rand() > 0.2 ? Math.round(rand() * 3600 * 100) / 100 : undefined,
        laneTier: randomFrom(rand, LANE_TIER_INPUTS)
      }

      const mongoResult = await mongoDb.generateUpload(opts)
      const pgResult = await pgDb.generateUpload(opts)

      // ids differ (independently generated) but must share a SHAPE, and the
      // derived path must differ only by that id.
      const mongoId = `${mongoResult.id}`
      const pgId = `${pgResult.id}`
      if (!/^[0-9a-f]{24}$/.test(mongoId) || !/^[0-9a-f]{24}$/.test(pgId)) {
        mismatches.push({ i, why: 'id shape', mongoId, pgId })
      }
      if (mongoResult.path !== `${opts.streamId}/${mongoId}.${opts.fileExtension}`) {
        mismatches.push({ i, why: 'mongo path', path: mongoResult.path })
      }
      if (pgResult.path !== `${opts.streamId}/${pgId}.${opts.fileExtension}`) {
        mismatches.push({ i, why: 'pg path', path: pgResult.path })
      }
      if (Object.keys(mongoResult).sort().join(',') !== Object.keys(pgResult).sort().join(',')) {
        mismatches.push({ i, why: 'result keys', mongo: Object.keys(mongoResult), pg: Object.keys(pgResult) })
      }

      // persisted laneTier must agree exactly
      const mongoDoc = await mongoDb.getUpload(mongoId)
      const pgDoc = await pgDb.getUpload(pgId)
      if (mongoDoc.laneTier !== pgDoc.laneTier) {
        mismatches.push({ i, why: 'laneTier', input: opts.laneTier, mongo: mongoDoc.laneTier, pg: pgDoc.laneTier })
      }
      if (mongoDoc.status !== pgDoc.status) {
        mismatches.push({ i, why: 'status', mongo: mongoDoc.status, pg: pgDoc.status })
      }
      if (`${mongoDoc._id}` !== mongoId || `${pgDoc._id}` !== pgId) {
        mismatches.push({ i, why: '_id not echoed' })
      }
    }

    expect(mismatches.slice(0, 5)).toEqual([])
    expect(mismatches).toHaveLength(0)
  }, 300000)
})

describePg('parity: laneTier latent divergence (documented, not a regression)', () => {
  test('TRUTHY non-string laneTier throws on Mongo but normalises to standard on PG', async () => {
    // Found by this harness on 2026-08-11. `mongo.js` calls
    // `(laneTier || '').toLowerCase()`, so a TRUTHY non-string (1, {}, [],
    // true, a Date) raises TypeError. Measured, not assumed: FALSY non-strings
    // (0, false, NaN, null, undefined) short-circuit to '' and are fine — so
    // the boundary is truthiness, not type. It is NOT reachable in production:
    // deriveLaneTier() String()-coerces and whitelists before calling
    // generateUpload, so the seam only ever receives a canonical string.
    //
    // The PG implementation coerces with template interpolation and therefore
    // returns 'standard' instead of throwing. This test PINS that difference
    // deliberately: it is a strict robustness improvement on an unreachable
    // path, and pinning it means a future change to either side is a visible
    // decision rather than a silent drift.
    const opts = { streamId: 'lane-divergence', fileExtension: 'flac', timestamp: new Date().toISOString() }

    // truthy non-strings: Mongo throws, PG normalises
    for (const bad of [1, 42, {}, [1], true, new Date(0)]) {
      let mongoErr
      try {
        await mongoDb.generateUpload({ ...opts, laneTier: bad })
      } catch (e) {
        mongoErr = e
      }
      expect(mongoErr).toBeInstanceOf(TypeError)

      const pgResult = await pgDb.generateUpload({ ...opts, laneTier: bad })
      const pgDoc = await pgDb.getUpload(`${pgResult.id}`)
      expect(pgDoc.laneTier).toBe('standard')
    }

    // falsy non-strings: BOTH engines accept and default to standard
    for (const falsy of [0, false, NaN]) {
      const m = await mongoDb.generateUpload({ ...opts, laneTier: falsy })
      const p = await pgDb.generateUpload({ ...opts, laneTier: falsy })
      const mDoc = await mongoDb.getUpload(`${m.id}`)
      const pDoc = await pgDb.getUpload(`${p.id}`)
      expect(mDoc.laneTier).toBe('standard')
      expect(pDoc.laneTier).toBe(mDoc.laneTier)
    }
  }, 120000)
})

describePg('parity: updateUploadStatus semantics', () => {
  test('status flips, failureMessage clear rules and ingestionResult retention agree across engines', async () => {
    const rand = makeRandom(SEED + 1)
    const statuses = [0, 10, 20, 30, 31, 32]
    const mismatches = []

    for (let i = 0; i < 60; i++) {
      const seedOpts = {
        streamId: randomStreamId(rand),
        fileExtension: 'flac',
        timestamp: new Date().toISOString(),
        originalFilename: 'a.flac',
        checksum: 'c'
      }
      const m = await mongoDb.generateUpload(seedOpts)
      const p = await pgDb.generateUpload(seedOpts)

      // seed a failure message on both, so the clear rules are exercised
      await mongoDb.updateUploadStatus(`${m.id}`, 30, 'seeded failure')
      await pgDb.updateUploadStatus(`${p.id}`, 30, 'seeded failure')

      const nextStatus = randomFrom(rand, statuses)
      const failureMessage = rand() > 0.5 ? `failure-${i}` : null
      const ingestionResult = rand() > 0.6 ? { streamSourceFileId: `ssf-${i}`, segments: [{ id: `seg-${i}`, path: 'p' }] } : null

      await mongoDb.updateUploadStatus(`${m.id}`, nextStatus, failureMessage, ingestionResult)
      await pgDb.updateUploadStatus(`${p.id}`, nextStatus, failureMessage, ingestionResult)

      const mDoc = await mongoDb.getUpload(`${m.id}`)
      const pDoc = await pgDb.getUpload(`${p.id}`)

      const mFailure = mDoc.failureMessage === undefined || mDoc.failureMessage === null ? null : mDoc.failureMessage
      const pFailure = pDoc.failureMessage === undefined || pDoc.failureMessage === null ? null : pDoc.failureMessage
      if (mFailure !== pFailure) {
        mismatches.push({ i, why: 'failureMessage', nextStatus, failureMessage, mongo: mFailure, pg: pFailure })
      }
      if (mDoc.status !== pDoc.status) {
        mismatches.push({ i, why: 'status', mongo: mDoc.status, pg: pDoc.status })
      }
      const mSsf = mDoc.ingestionResult?.streamSourceFileId ?? null
      const pSsf = pDoc.ingestionResult?.streamSourceFileId ?? null
      if (mSsf !== pSsf) {
        mismatches.push({ i, why: 'ingestionResult', mongo: mSsf, pg: pSsf })
      }
    }

    expect(mismatches.slice(0, 5)).toEqual([])
    expect(mismatches).toHaveLength(0)
  }, 300000)

  test('invalid status throws SYNCHRONOUSLY on both engines with the same message', async () => {
    const m = await mongoDb.generateUpload({ streamId: 's', fileExtension: 'flac', timestamp: new Date().toISOString() })
    const p = await pgDb.generateUpload({ streamId: 's', fileExtension: 'flac', timestamp: new Date().toISOString() })
    for (const bad of [99, -1, 1.5, 'ok']) {
      let mongoErr, pgErr
      try { mongoDb.updateUploadStatus(`${m.id}`, bad) } catch (e) { mongoErr = e }
      try { pgDb.updateUploadStatus(`${p.id}`, bad) } catch (e) { pgErr = e }
      expect(mongoErr).toBeDefined()
      expect(pgErr).toBeDefined()
      expect(pgErr.message).toBe(mongoErr.message)
    }
  })

  test('a missing row rejects with the same message on both engines', async () => {
    const absent = 'a'.repeat(24)
    const mongoErr = await mongoDb.updateUploadStatus(absent, 20).catch(e => e)
    const pgErr = await pgDb.updateUploadStatus(absent, 20).catch(e => e)
    expect(mongoErr.message).toBe('Upload does not exist')
    expect(pgErr.message).toBe(mongoErr.message)
  })
})

describePg('parity: getUpload error semantics', () => {
  test('malformed ids reject with a byte-identical message; absent-but-valid ids resolve falsy', async () => {
    const malformed = ['not-an-id', '', 'zzzz', 'a'.repeat(23), 'a'.repeat(25), 'ghijklmnopqrstuvwxyz1234', '!!!']
    for (const bad of malformed) {
      const mongoErr = await mongoDb.getUpload(bad).catch(e => e)
      const pgErr = await pgDb.getUpload(bad).catch(e => e)
      expect(mongoErr).toBeInstanceOf(Error)
      expect(pgErr).toBeInstanceOf(Error)
      expect(pgErr.message).toBe(mongoErr.message)
      expect(pgErr.message).toBe('Upload with given id not found.')
      expect(pgErr.constructor.name).toBe(mongoErr.constructor.name)
    }
    const absent = 'a'.repeat(24)
    expect(await mongoDb.getUpload(absent)).toBeFalsy()
    expect(await pgDb.getUpload(absent)).toBeFalsy()
  })
})

describePg('parity: quota aggregation', () => {
  test('getPendingProjectDuration agrees across engines for randomised row sets', async () => {
    const rand = makeRandom(SEED + 2)
    for (let round = 0; round < 8; round++) {
      await pgTesting.truncate()
      await mongoTesting.truncate()
      const projectId = `project-${round}`
      for (let i = 0; i < 12; i++) {
        const opts = {
          streamId: randomStreamId(rand),
          fileExtension: 'flac',
          timestamp: new Date().toISOString(),
          projectId: rand() > 0.25 ? projectId : `other-${round}`,
          duration: Math.round(rand() * 500 * 100) / 100
        }
        const m = await mongoDb.generateUpload(opts)
        const p = await pgDb.generateUpload(opts)
        const nextStatus = randomFrom(rand, [0, 10, 20, 30])
        if (nextStatus !== 0) {
          await mongoDb.updateUploadStatus(`${m.id}`, nextStatus)
          await pgDb.updateUploadStatus(`${p.id}`, nextStatus)
        }
      }
      const mongoTotal = await mongoDb.getPendingProjectDuration(projectId)
      const pgTotal = await pgDb.getPendingProjectDuration(projectId)
      // rounded: float accumulation order differs between engines
      expect(Math.round(pgTotal * 100) / 100).toBeCloseTo(Math.round(mongoTotal * 100) / 100, 6)
      expect(typeof pgTotal).toBe('number')
    }
  }, 300000)

  test('status counts agree across engines', async () => {
    for (const statusNumber of [30, 31]) {
      for (let i = 0; i < 3; i++) {
        const opts = { streamId: 's', fileExtension: 'flac', timestamp: new Date().toISOString() }
        const m = await mongoDb.generateUpload(opts)
        const p = await pgDb.generateUpload(opts)
        await mongoDb.updateUploadStatus(`${m.id}`, statusNumber)
        await pgDb.updateUploadStatus(`${p.id}`, statusNumber)
      }
    }
    expect(await pgDb.getUploadFailedCount()).toBe(await mongoDb.getUploadFailedCount())
    expect(await pgDb.getUploadDuplicateCount()).toBe(await mongoDb.getUploadDuplicateCount())
  }, 120000)
})

describePg('parity: multipart lifecycle', () => {
  test('set / complete / abort produce the same observable subdocument on both engines', async () => {
    const opts = { streamId: 'stream1', fileExtension: 'flac', timestamp: new Date().toISOString() }
    const m = await mongoDb.generateUpload(opts)
    const p = await pgDb.generateUpload(opts)

    // before: the route guard must reject identically
    let mDoc = await mongoDb.getUpload(`${m.id}`)
    let pDoc = await pgDb.getUpload(`${p.id}`)
    expect(!pDoc.multipart || !pDoc.multipart.uploadId).toBe(!mDoc.multipart || !mDoc.multipart.uploadId)

    const multipart = { uploadId: 'mp-abc', partSizeBytes: 67108864, partCount: 5 }
    await mongoDb.setUploadMultipart(`${m.id}`, multipart)
    await pgDb.setUploadMultipart(`${p.id}`, multipart)
    mDoc = await mongoDb.getUpload(`${m.id}`)
    pDoc = await pgDb.getUpload(`${p.id}`)
    expect(pDoc.multipart.uploadId).toBe(mDoc.multipart.uploadId)
    expect(pDoc.multipart.partSizeBytes).toBe(mDoc.multipart.partSizeBytes)
    expect(pDoc.multipart.partCount).toBe(mDoc.multipart.partCount)

    await mongoDb.setUploadMultipartCompleted(`${m.id}`)
    await pgDb.setUploadMultipartCompleted(`${p.id}`)
    mDoc = await mongoDb.getUpload(`${m.id}`)
    pDoc = await pgDb.getUpload(`${p.id}`)
    expect(Boolean(pDoc.multipart.completedAt)).toBe(Boolean(mDoc.multipart.completedAt))
    expect(pDoc.multipart.uploadId).toBe(mDoc.multipart.uploadId) // merge, not clobber

    await mongoDb.setUploadMultipartAborted(`${m.id}`)
    await pgDb.setUploadMultipartAborted(`${p.id}`)
    mDoc = await mongoDb.getUpload(`${m.id}`)
    pDoc = await pgDb.getUpload(`${p.id}`)
    expect(Boolean(pDoc.multipart.abortedAt)).toBe(Boolean(mDoc.multipart.abortedAt))
    expect(pDoc.multipart.uploadId).toBe(mDoc.multipart.uploadId)
  }, 120000)
})

describePg('parity: GET /uploads/:id wire fields', () => {
  test('the NAMED response field set is identical across engines (__v explicitly NOT guaranteed)', async () => {
    const opts = {
      streamId: 'stream-wire',
      userId: 'user-wire',
      fileExtension: 'flac',
      timestamp: new Date().toISOString(),
      originalFilename: 'wire.flac',
      checksum: 'wire-sum',
      projectId: 'project-wire',
      duration: 12.5
    }
    const m = await mongoDb.generateUpload(opts)
    const p = await pgDb.generateUpload(opts)
    const ingestionResult = {
      streamSourceFileId: 'ssf-wire',
      projectId: 'core-project',
      siteId: 'site-1',
      arbimonProjectId: 'arb-p',
      arbimonSiteId: 'arb-s',
      segments: [{ id: 'seg-1', path: 'a/b.flac' }]
    }
    await mongoDb.updateUploadStatus(`${m.id}`, 20, null, ingestionResult)
    await pgDb.updateUploadStatus(`${p.id}`, 20, null, ingestionResult)

    const mDoc = await mongoDb.getUpload(`${m.id}`)
    const pDoc = await pgDb.getUpload(`${p.id}`)

    // Mirrors uploadStatusResponse() in routes/uploads.js — the wire contract.
    const wire = (upload) => {
      const ir = upload.ingestionResult || {}
      return {
        uploadId: `${upload._id}`,
        status: upload.status,
        failureMessage: upload.failureMessage || null,
        hasCreatedAt: Boolean(upload.createdAt),
        hasUpdatedAt: Boolean(upload.updatedAt),
        stream: {
          id: upload.streamId,
          projectId: upload.projectId || ir.projectId,
          siteId: ir.siteId,
          arbimonProjectId: ir.arbimonProjectId,
          arbimonSiteId: ir.arbimonSiteId
        },
        streamSourceFileId: ir.streamSourceFileId,
        segmentCount: (ir.segments || []).length
      }
    }

    const mWire = wire(mDoc)
    const pWire = wire(pDoc)
    // uploadId differs (independent ids) — compare shape, then the rest exactly
    expect(pWire.uploadId).toMatch(/^[0-9a-f]{24}$/)
    expect(mWire.uploadId).toMatch(/^[0-9a-f]{24}$/)
    delete mWire.uploadId
    delete pWire.uploadId
    expect(pWire).toEqual(mWire)
  }, 120000)
})
