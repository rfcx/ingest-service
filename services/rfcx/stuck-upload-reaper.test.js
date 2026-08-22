const db = require('../db/uploads')

jest.mock('./segments', () => ({
  findIngestedDuplicateStrict: jest.fn(),
  findIngestedDuplicate: jest.fn(),
  getExistingSourceFile: jest.fn(),
  createStreamFileData: jest.fn(),
  deleteStreamSourceFile: jest.fn()
}))
jest.mock('../db/uploads', () => ({
  status: { WAITING: 0, UPLOADED: 10, INGESTED: 20, FAILED: 30, DUPLICATE: 31, CHECKSUM: 32 },
  findStuckUploads: jest.fn(),
  updateUploadStatus: jest.fn().mockResolvedValue(undefined)
}))

const segments = require('./segments')
const { runStuckUploadReaper, buildConfig, classify } = require('./stuck-upload-reaper')

const upload = (over = {}) => ({
  id: 'u1',
  originalFilename: 'f.wav',
  streamId: 's1',
  checksum: 'abc',
  timestamp: new Date('2026-08-21T20:52:00Z'),
  ...over
})

beforeEach(() => {
  jest.clearAllMocks()
  db.findStuckUploads.mockResolvedValue([])
})

describe('buildConfig', () => {
  test('defaults are conservative: dry-run ON, 3h age, UPLOADED only', () => {
    const c = buildConfig({})
    expect(c.dryRun).toBe(true)
    expect(c.ageHours).toBe(3)
    expect(c.statuses).toEqual([10])
  })

  // Regression guard for the 2026-08-22 false positive: treating WAITING(0) as
  // stuck matched 18,105 rows whose audio was in fact present (probed 5/5).
  test('NEVER includes WAITING(0) — it is a normal resting state, not a stall', () => {
    expect(buildConfig({}).statuses).not.toContain(0)
  })
})

describe('classify', () => {
  test('class A: source file with healthy segments => ingest actually succeeded', async () => {
    segments.findIngestedDuplicateStrict.mockResolvedValue({
      id: 'ssf1', segments: [{ availability: 1 }, { availability: 1 }]
    })
    expect((await classify(upload())).klass).toBe('A')
  })

  test('class B: nothing in core', async () => {
    segments.findIngestedDuplicateStrict.mockResolvedValue(null)
    expect((await classify(upload())).klass).toBe('B')
  })

  test('class B: source file present but no segments', async () => {
    segments.findIngestedDuplicateStrict.mockResolvedValue({ id: 'ssf1', segments: [] })
    expect((await classify(upload())).klass).toBe('B')
  })

  test('class C: segments exist but core marks them unavailable', async () => {
    segments.findIngestedDuplicateStrict.mockResolvedValue({
      id: 'ssf1', segments: [{ availability: 1 }, { availability: 0 }]
    })
    expect((await classify(upload())).klass).toBe('C')
  })

  // THE important one. A Core outage must never be read as "absent" and turned
  // into a terminal FAILED status.
  test('class SKIP: a failing core lookup is inconclusive, NOT absence', async () => {
    segments.findIngestedDuplicateStrict.mockRejectedValue(new Error('ECONNREFUSED'))
    const d = await classify(upload())
    expect(d.klass).toBe('SKIP')
    expect(d.reason).toMatch(/inconclusive/)
  })

  test('missing checksum cannot be classified => B, never a false A', async () => {
    expect((await classify(upload({ checksum: null }))).klass).toBe('B')
    expect(segments.findIngestedDuplicateStrict).not.toHaveBeenCalled()
  })
})

describe('runStuckUploadReaper', () => {
  test('dry run performs NO writes', async () => {
    db.findStuckUploads.mockResolvedValue([upload()])
    segments.findIngestedDuplicateStrict.mockResolvedValue({ id: 's', segments: [{ availability: 1 }] })
    const counts = await runStuckUploadReaper({ STUCK_UPLOAD_REAPER_DRY_RUN: 'true' })
    expect(counts.settled).toBe(1)
    expect(db.updateUploadStatus).not.toHaveBeenCalled()
  })

  test('class A settles to INGESTED, never FAILED', async () => {
    db.findStuckUploads.mockResolvedValue([upload()])
    segments.findIngestedDuplicateStrict.mockResolvedValue({ id: 's', segments: [{ availability: 1 }] })
    await runStuckUploadReaper({ STUCK_UPLOAD_REAPER_DRY_RUN: 'false' })
    expect(db.updateUploadStatus).toHaveBeenCalledWith('u1', 20, null)
  })

  test('class B marks FAILED with a retryable message', async () => {
    db.findStuckUploads.mockResolvedValue([upload()])
    segments.findIngestedDuplicateStrict.mockResolvedValue(null)
    await runStuckUploadReaper({ STUCK_UPLOAD_REAPER_DRY_RUN: 'false' })
    expect(db.updateUploadStatus).toHaveBeenCalledWith('u1', 30, expect.stringMatching(/try again/i))
  })

  test('class C is REPORT ONLY — it must never write or delete', async () => {
    db.findStuckUploads.mockResolvedValue([upload()])
    segments.findIngestedDuplicateStrict.mockResolvedValue({ id: 's', segments: [{ availability: 0 }] })
    const counts = await runStuckUploadReaper({ STUCK_UPLOAD_REAPER_DRY_RUN: 'false' })
    expect(counts.reported).toBe(1)
    expect(db.updateUploadStatus).not.toHaveBeenCalled()
  })

  test('SKIP writes nothing, leaving the row for the next run', async () => {
    db.findStuckUploads.mockResolvedValue([upload()])
    segments.findIngestedDuplicateStrict.mockRejectedValue(new Error('503'))
    const counts = await runStuckUploadReaper({ STUCK_UPLOAD_REAPER_DRY_RUN: 'false' })
    expect(counts.skipped).toBe(1)
    expect(db.updateUploadStatus).not.toHaveBeenCalled()
  })

  test('one bad row does not abort the batch', async () => {
    db.findStuckUploads.mockResolvedValue([upload({ id: 'a' }), upload({ id: 'b' })])
    segments.findIngestedDuplicateStrict
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 's', segments: [{ availability: 1 }] })
    db.updateUploadStatus.mockRejectedValueOnce(new Error('db down'))
    const counts = await runStuckUploadReaper({ STUCK_UPLOAD_REAPER_DRY_RUN: 'false' })
    expect(counts.scanned).toBe(2)
    expect(counts.error).toBe(1)
  })

  test('queries only rows older than the cutoff', async () => {
    await runStuckUploadReaper({ STUCK_UPLOAD_REAPER_AGE_HOURS: '3' })
    const arg = db.findStuckUploads.mock.calls[0][0]
    expect(arg.statuses).toEqual([10])
    expect(Date.now() - arg.updatedBefore.getTime()).toBeGreaterThan(2.9 * 3600 * 1000)
  })
})
