const mongoose = require('mongoose')
const moment = require('moment-timezone')

const { status } = require('../db/mongo')
const UploadModel = require('../db/models/mongoose/upload').Upload
const segmentService = require('./segments')
const storage = require(`../storage/${process.env.PLATFORM || 'amazon'}`)
const { buildConfig, runUploadSourceCleanup, uploadSourceKey } = require('./upload-source-cleanup')
const { startDb, stopDb, truncateDbModels, muteConsole } = require('../../utils/testing')

const oldEnv = process.env

beforeAll(async () => {
  muteConsole('info')
  muteConsole('warn')
  await startDb()
})

beforeEach(async () => {
  process.env = { ...oldEnv, UPLOAD_BUCKET: 'rfcx-ingest-production' }
  await truncateDbModels(UploadModel)
  jest.spyOn(segmentService, 'findIngestedDuplicate').mockResolvedValue({ id: 'source-file-id' })
  jest.spyOn(storage, 'deleteObject').mockResolvedValue({})
})

afterEach(() => {
  process.env = oldEnv
  jest.restoreAllMocks()
})

afterAll(async () => {
  await stopDb()
})

function uploadDoc (overrides = {}) {
  return new UploadModel({
    _id: new mongoose.Types.ObjectId(),
    streamId: 'stream123',
    userId: 'user123',
    status: status.INGESTED,
    timestamp: moment.utc().subtract(2, 'days').toDate(),
    updatedAt: moment.utc().subtract(25, 'hours').toDate(),
    createdAt: moment.utc().subtract(2, 'days').toDate(),
    originalFilename: 'REC001.WAV',
    checksum: 'a'.repeat(40),
    ...overrides
  }).save()
}

describe('upload source cleanup', () => {
  test('defaults to ingested and duplicate terminal statuses', () => {
    expect(buildConfig({}).statuses).toEqual([status.INGESTED, status.DUPLICATE])
  })

  test('builds upload source key from stream, id, and original extension', async () => {
    const upload = await uploadDoc()
    expect(uploadSourceKey(upload)).toBe(`stream123/${upload._id}.wav`)
  })

  test('uses persisted upload source key when present', async () => {
    const upload = await uploadDoc({ uploadSource: { bucket: 'r2-locale-a', key: 'custom/source.flac' } })
    expect(uploadSourceKey(upload)).toBe('custom/source.flac')
  })

  test('dry-run scans eligible ingested uploads without deleting or marking', async () => {
    const upload = await uploadDoc()
    const counts = await runUploadSourceCleanup({ dryRun: true, ageHours: 24, batchSize: 10, statuses: [status.INGESTED], coreVerify: true })

    expect(counts.dryRun).toBe(1)
    expect(segmentService.findIngestedDuplicate).toHaveBeenCalledWith('stream123', 'a'.repeat(40), expect.any(Object))
    expect(storage.deleteObject).not.toHaveBeenCalled()
    const after = await UploadModel.findById(upload._id)
    expect(after.uploadSourceDeletedAt).toBeUndefined()
  })

  test('deletes and marks eligible ingested uploads when dry-run is disabled', async () => {
    const upload = await uploadDoc()
    const counts = await runUploadSourceCleanup({ dryRun: false, ageHours: 24, batchSize: 10, statuses: [status.INGESTED], coreVerify: true })

    expect(counts.deleted).toBe(1)
    expect(storage.deleteObject).toHaveBeenCalledWith('rfcx-ingest-production', `stream123/${upload._id}.wav`)
    const after = await UploadModel.findById(upload._id)
    expect(after.uploadSourceDeletedAt).toBeTruthy()
  })

  test('deletes from persisted upload source when present', async () => {
    const upload = await uploadDoc({ uploadSource: { bucket: 'r2-locale-a', key: 'custom/source.flac' } })
    const counts = await runUploadSourceCleanup({ dryRun: false, ageHours: 24, batchSize: 10, statuses: [status.INGESTED], coreVerify: true })

    expect(counts.deleted).toBe(1)
    expect(storage.deleteObject).toHaveBeenCalledWith('r2-locale-a', 'custom/source.flac')
    const after = await UploadModel.findById(upload._id)
    expect(after.uploadSourceCleanupMessage).toBe('deleted r2-locale-a/custom/source.flac')
  })

  test('does not delete failed or recently updated uploads', async () => {
    await uploadDoc({ status: status.FAILED })
    await uploadDoc({ updatedAt: moment.utc().subtract(2, 'hours').toDate() })
    const counts = await runUploadSourceCleanup({ dryRun: false, ageHours: 24, batchSize: 10, statuses: [status.INGESTED], coreVerify: true })

    expect(counts.scanned).toBe(0)
    expect(storage.deleteObject).not.toHaveBeenCalled()
  })

  test('skips when Core does not confirm the upload is ingested', async () => {
    await uploadDoc()
    segmentService.findIngestedDuplicate.mockResolvedValue(null)
    const counts = await runUploadSourceCleanup({ dryRun: false, ageHours: 24, batchSize: 10, statuses: [status.INGESTED], coreVerify: true })

    expect(counts.skippedCoreUnconfirmed).toBe(1)
    expect(storage.deleteObject).not.toHaveBeenCalled()
  })
})
