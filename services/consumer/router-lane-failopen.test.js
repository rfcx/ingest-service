// ---------------------------------------------------------------------------
// The lane router must FAIL OPEN (mongo2pg S1).
//
// `laneTierForBody()` looks the upload up in the upload store to decide which
// lane an S3 event is republished to. If that lookup fails — DB blip, unknown
// id, malformed id, engine switch mid-flight — it must return 'standard' and
// NEVER throw, because throwing here would drop a real user's ingest event.
//
// This matters specifically for the mongo2pg port: `getUpload` REJECTS on a
// malformed id (the CastError shim) rather than resolving null, so the
// swallow-and-default behaviour is load-bearing on both engines.
// ---------------------------------------------------------------------------

jest.mock('../db/uploads', () => ({
  getUpload: jest.fn(),
  status: { WAITING: 0, UPLOADED: 10, INGESTED: 20, FAILED: 30, DUPLICATE: 31, CHECKSUM: 32 }
}))

const db = require('../db/uploads')
const { laneTierForBody } = require('./router')

const bodyFor = (uploadId) => ({
  Records: [{ eventName: 'ObjectCreated:Put', s3: { object: { key: `stream1/${uploadId}.flac` } } }]
})

const VALID_ID = 'a1b2c3d4e5f6a1b2c3d4e5f6'

beforeEach(() => {
  jest.clearAllMocks()
})

describe('laneTierForBody fail-open', () => {
  test('returns the upload lane tier when the lookup succeeds', async () => {
    db.getUpload.mockResolvedValue({ laneTier: 'express' })
    await expect(laneTierForBody(bodyFor(VALID_ID))).resolves.toBe('express')
  })

  test('returns standard (never throws) when getUpload REJECTS — the DB-blip case', async () => {
    db.getUpload.mockRejectedValue(new Error('connection terminated unexpectedly'))
    await expect(laneTierForBody(bodyFor(VALID_ID))).resolves.toBe('standard')
  })

  test('returns standard when getUpload rejects EmptyResultError — the malformed-id/CastError shim path', async () => {
    const { EmptyResultError } = require('@rfcx/http-utils')
    db.getUpload.mockRejectedValue(new EmptyResultError('Upload with given id not found.'))
    await expect(laneTierForBody(bodyFor('not-a-valid-id'))).resolves.toBe('standard')
  })

  test('returns standard when the upload is absent (resolves null)', async () => {
    db.getUpload.mockResolvedValue(null)
    await expect(laneTierForBody(bodyFor(VALID_ID))).resolves.toBe('standard')
  })

  test('returns standard when the upload has an unknown/empty lane tier', async () => {
    for (const laneTier of [undefined, null, '', '   ', 'nonsense', 'expres', 0, {}]) {
      db.getUpload.mockResolvedValue({ laneTier })
      await expect(laneTierForBody(bodyFor(VALID_ID))).resolves.toBe('standard')
    }
  })

  test('normalises case and surrounding whitespace (lanes.normaliseTier trims + lowercases)', async () => {
    for (const [stored, expected] of [['EXPRESS ', 'express'], [' priority', 'priority'], ['StAnDaRd', 'standard']]) {
      db.getUpload.mockResolvedValue({ laneTier: stored })
      await expect(laneTierForBody(bodyFor(VALID_ID))).resolves.toBe(expected)
    }
  })

  test('returns standard without touching the DB when no upload id can be parsed', async () => {
    await expect(laneTierForBody({ Records: [] })).resolves.toBe('standard')
    await expect(laneTierForBody({})).resolves.toBe('standard')
    expect(db.getUpload).not.toHaveBeenCalled()
  })

  test('never rejects for any of the failure shapes above', async () => {
    const shapes = [
      () => { throw new Error('sync throw') },
      () => Promise.reject(new Error('async reject')),
      () => Promise.resolve(undefined)
    ]
    for (const shape of shapes) {
      db.getUpload.mockImplementation(shape)
      await expect(laneTierForBody(bodyFor(VALID_ID))).resolves.toBe('standard')
    }
  })
})
