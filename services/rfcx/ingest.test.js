/* eslint-disable no-unused-vars */
const ingestService = require('./ingest')
const path = require('path')
const fs = require('fs')
const platform = process.env.PLATFORM || 'amazon'
const storage = require(`../storage/${platform}`)
const audioService = require('../audio')
const segmentService = require('../rfcx/segments')
const { status } = require('../../services/db/mongo')
const { rimraf } = require('rimraf')
const mongoose = require('mongoose')

const originalEnv = process.env

const { startDb, stopDb, truncateDbModels, muteConsole, seedValues } = require('../../utils/testing')
const { IngestionError } = require('../../utils/errors')

const UploadModel = require('../../services/db/models/mongoose/upload').Upload

const UPLOAD = { id: new mongoose.Types.ObjectId(), originalFilename: '0a1824085e3f-2021-06-08T19-26-40.flac', timestamp: '2021-06-08T19:26:40.000Z', streamId: '0a1824085e3f', checksum: 'c0cdd1156b69c8255ff83b9eb0ba6412cced8411', sampleRate: 48000, targetBitrate: 1, duration: 250000 }

// Per-worker temp dir — see the note in services/audio.test.js: this path
// was shared with that suite and rimraf'd by both.
const tempDirPath = path.join(__dirname, `../../test/tmp-w${process.env.JEST_WORKER_ID || '0'}/`)

beforeAll(async () => {
  muteConsole('warn')
  await startDb()
})
beforeEach(async () => {
  process.env = { ...originalEnv, UPLOAD_BUCKET: 'streams-uploads' }
  if (!fs.existsSync(tempDirPath)) {
    fs.mkdirSync(tempDirPath)
  }

  await truncateDbModels(UploadModel)
  await UploadModel(UPLOAD).save()
  jest.spyOn(storage, 'download').mockReturnValue('')
  jest.spyOn(storage, 'upload').mockReturnValue(Promise.resolve({ ETag: true }))
  jest.spyOn(storage, 'deleteObject').mockReturnValue('')
  jest.spyOn(storage, 'copyFromSource').mockReturnValue(Promise.resolve({ ETag: true }))
  jest.spyOn(storage, 'copy').mockReturnValue('')
  jest.spyOn(storage, 'createFromData').mockReturnValue('')
  jest.spyOn(audioService, 'convert').mockResolvedValue({
    meta: {
      duration: 299.806032,
      sampleCount: 13221446,
      sampleRate: 48000,
      bitRate: 1,
      codec: 'pcm_s16le',
      size: 6672949,
      checksum: UPLOAD.checksum
    }
  })
  jest.spyOn(audioService, 'split').mockResolvedValue([0, 1, 2, 3, 4].map((idx) => ({
    path: `${tempDirPath}segment-${idx}.wav`,
    meta: {
      duration: 60,
      sampleCount: 2880000,
      size: 1024 + idx
    }
  })))
  jest.spyOn(segmentService, 'createStreamFileData').mockReturnValue({
    streamSourceFile: {
      id: 'e52edb98-e482-41e3-b9fb-95de76d1f7e2',
      streamId: 'mm8uca730apw',
      filename: '0a1824085e3f-2021-06-08T19-26-40.flac',
      audioFileFormatId: 3,
      duration: 299,
      sampleCount: 13221446,
      sampleRate: 48000,
      channelsCount: 1,
      bitRate: 1,
      audioCodecId: 4,
      sha1Checksum: 'c0cdd1156b69c8255ff83b9eb0ba6412cced8411',
      meta: null,
      updatedAt: '2024-02-16T12:36:25.270Z',
      createdAt: '2024-02-16T12:36:25.270Z'
    },
    streamSegments: [
      {
        id: '6ec8579f-e5b4-4d97-b4ce-c625a10908fb',
        start: '2021-06-08T19:26:40.000Z'
      },
      {
        id: '31768a27-000d-468f-a127-d83ebd7d530d',
        start: '2021-06-08T19:27:40.000Z'
      },
      {
        id: 'f9572d63-f644-45bc-8942-8557ddb39c64',
        start: '2021-06-08T19:28:40.000Z'
      },
      {
        id: 'a5463d99-5ef9-4b07-8ef1-b992732052e7',
        start: '2021-06-08T19:29:40.000Z'
      },
      {
        id: '5190d9fc-83e7-4440-aec1-5b6522a0c1e6',
        start: '2021-06-08T19:30:40.000Z'
      }
    ]
  })
  jest.spyOn(segmentService, 'deleteStreamSourceFile').mockReturnValue({})
})
afterEach(async () => {
  process.env = originalEnv
  await rimraf(tempDirPath + '*', { glob: true })
  // Restore all spies between tests. Otherwise per-test spies (e.g.
  // jest.spyOn(segmentService,'createStreamFileData')) accumulate call counts
  // across tests on top of the beforeEach spies, so assertions like
  // expect(createSpy).not.toHaveBeenCalled() see leaked calls from earlier
  // tests and fail depending on suite order (the CI flakiness root cause).
  jest.restoreAllMocks()
})
afterAll(async () => {
  await stopDb()
})

describe('Test ingest service', () => {
  test('Can ingest audio', async () => {
    const fileName = 'test-5mins-lv8.flac'
    const pathFile = path.join(__dirname, '../../test/', fileName)
    const tempFilePath = tempDirPath + fileName
    process.env.CACHE_DIRECTORY = tempDirPath
    // copy test file to tmp dir
    fs.copyFile(pathFile, tempFilePath, (err) => {
      console.info(err)
    })
    const upload = await UploadModel.findOne({ checksum: UPLOAD.checksum })
    upload.failureMessage = 'previous transient failure'
    await upload.save()

    await ingestService.ingest(`${UPLOAD.streamId}/${fileName}`, tempFilePath, UPLOAD.streamId, upload.id)

    const newUpload = await UploadModel.findOne({ checksum: UPLOAD.checksum })
    expect(newUpload.status).toBe(status.INGESTED)
    expect(newUpload.failureMessage).toBeUndefined()
    expect(newUpload.ingestionResult.streamSourceFileId).toBe('e52edb98-e482-41e3-b9fb-95de76d1f7e2')
    expect(newUpload.ingestionResult.streamId).toBe(UPLOAD.streamId)
    expect(newUpload.ingestionResult.segments).toHaveLength(5)
    expect(newUpload.ingestionResult.segments[0].id).toBe('6ec8579f-e5b4-4d97-b4ce-c625a10908fb')
    expect(newUpload.ingestionResult.segments[0].path).toBe(`2021/06/08/${UPLOAD.streamId}/6ec8579f-e5b4-4d97-b4ce-c625a10908fb.flac`)
    expect(storage.download).toHaveBeenCalledWith(`${UPLOAD.streamId}/${fileName}`, path.join(tempDirPath, UPLOAD.streamId, fileName), expect.objectContaining({ bucket: 'streams-uploads', key: `${UPLOAD.streamId}/${fileName}` }))
    expect(storage.deleteObject).not.toHaveBeenCalled()
  })

  test('Checksum error', async () => {
    const fileName = 'test-1min-lv8.flac'
    const pathFile = path.join(__dirname, '../../test/', fileName)
    const tempFilePath = tempDirPath + fileName
    process.env.CACHE_DIRECTORY = tempDirPath
    // copy test file to tmp dir
    fs.copyFile(pathFile, tempFilePath, (err) => {
      console.info(err)
    })
    const upload = await UploadModel.findOne({ checksum: UPLOAD.checksum })

    await ingestService.ingest(`${UPLOAD.streamId}/${fileName}`, tempFilePath, UPLOAD.streamId, upload.id)

    const newUpload = await UploadModel.findOne({ checksum: UPLOAD.checksum })
    expect(newUpload.status).toBe(status.CHECKSUM)
  })

  test('Not found error', async () => {
    const fileName = 'test-abcmin-lv8.flac'
    const pathFile = path.join(__dirname, '../../test/', fileName)
    const tempFilePath = tempDirPath + fileName
    process.env.CACHE_DIRECTORY = tempDirPath
    // copy test file to tmp dir
    fs.copyFile(pathFile, tempFilePath, (err) => {
      console.info(err)
    })
    const upload = await UploadModel.findOne({ checksum: UPLOAD.checksum })

    // An unexpected (non-IngestionError) failure records FAILED status AND
    // re-throws so the consumer nacks the message to the DLQ (transient /
    // unexpected outcomes are inspectable / redrivable). Handled-terminal
    // IngestionErrors (duplicate/checksum/etc.) resolve instead (ACK-drop).
    await expect(
      ingestService.ingest(`${UPLOAD.streamId}/${fileName}`, tempFilePath, UPLOAD.streamId, upload.id)
    ).rejects.toThrow()

    const newUpload = await UploadModel.findOne({ checksum: UPLOAD.checksum })
    expect(newUpload.status).toBe(status.FAILED)
    expect(newUpload.failureMessage).toBe('Server failed with processing your file. Please try again later.')
  })

  // Regression (2026-08-21, OPEN-ITEMS #196): an UNREADABLE source (empty /
  // truncated / not audio) must be TERMINAL, not the generic retryable
  // failure. Reproduces the production case exactly: a 131072-byte all-zeros
  // file, whose sha1 the client itself declared, retried ~2.1x/min forever
  // because routes/uploads.js:isRetryableUpload() treats the generic message
  // as retryable and the API answered `retry_upload`.
  test('Unreadable media (empty/zero-byte file) is terminal, NOT retryable', async () => {
    const fileName = 'test-zero-bytes.wav'
    const tempFilePath = tempDirPath + fileName
    process.env.CACHE_DIRECTORY = tempDirPath
    // 128 KiB of zeros: allocated but never written -- exactly what the
    // failing production uploads contained (no RIFF header, no audio).
    fs.writeFileSync(tempFilePath, Buffer.alloc(131072))
    const upload = await UploadModel.findOne({ checksum: UPLOAD.checksum })

    // Terminal IngestionErrors RESOLVE (consumer ACK-drops) rather than
    // rejecting -- an unreadable file must never be dead-lettered or requeued.
    await ingestService.ingest(`${UPLOAD.streamId}/${fileName}`, tempFilePath, UPLOAD.streamId, upload.id)

    const newUpload = await UploadModel.findOne({ checksum: UPLOAD.checksum })
    expect(newUpload.status).toBe(status.FAILED)
    // The load-bearing assertion: it must NOT be the retryable message.
    expect(newUpload.failureMessage).not.toBe('Server failed with processing your file. Please try again later.')
    expect(newUpload.failureMessage).toMatch(/Audio file could not be read/)
    expect(newUpload.failureMessage).toMatch(/will not help/)
  })

  test('Duplicate error', async () => {
    const fileName = 'test-5mins-lv8.flac'
    const pathFile = path.join(__dirname, '../../test/', fileName)
    const tempFilePath = tempDirPath + fileName
    process.env.CACHE_DIRECTORY = tempDirPath
    // copy test file to tmp dir
    fs.copyFile(pathFile, tempFilePath, (err) => {
      console.info(err)
    })
    const upload = await UploadModel.findOne({ checksum: UPLOAD.checksum })
    jest.spyOn(segmentService, 'createStreamFileData').mockRejectedValue(new IngestionError('Duplicate file. Matching sha1 signature already ingested.', status.DUPLICATE))

    await ingestService.ingest(`${UPLOAD.streamId}/${fileName}`, tempFilePath, UPLOAD.streamId, upload.id)

    const newUpload = await UploadModel.findOne({ checksum: UPLOAD.checksum })
    expect(newUpload.status).toBe(status.DUPLICATE)
    expect(newUpload.failureMessage).toBe('Duplicate file. Matching sha1 signature already ingested.')
  })

  test('Error archive streams from recorded upload source', async () => {
    const fileName = 'test-1min-lv8.flac'
    const pathFile = path.join(__dirname, '../../test/', fileName)
    const tempFilePath = tempDirPath + fileName
    process.env.CACHE_DIRECTORY = tempDirPath
    process.env.ERROR_BUCKET_ENABLED = 'true'
    process.env.ERROR_BUCKET = 'rfcx-streams-errors-production'
    fs.copyFile(pathFile, tempFilePath, (err) => { console.info(err) })
    const upload = await UploadModel.findOne({ checksum: UPLOAD.checksum })
    upload.uploadSource = {
      targetId: 'legacy-env-upload-bucket',
      targetVersion: 1,
      provider: 's3-compatible',
      bucket: 'rfcx-ingest-production',
      key: `${UPLOAD.streamId}/${fileName}`,
      endpoint: 'https://example.r2.cloudflarestorage.com',
      region: 'auto',
      forcePathStyle: true
    }
    await upload.save()

    const result = await ingestService.ingest(`${UPLOAD.streamId}/${fileName}`, tempFilePath, UPLOAD.streamId, upload.id)

    expect(result.outcome).toBe('handled-terminal')
    expect(result.status).toBe(status.CHECKSUM)
    expect(storage.copyFromSource).toHaveBeenCalledWith(expect.objectContaining({ bucket: 'rfcx-ingest-production', key: `${UPLOAD.streamId}/${fileName}` }), 'rfcx-streams-errors-production', `${UPLOAD.streamId}/${fileName}`)
    expect(storage.copy).not.toHaveBeenCalled()
  })

  test('Duplicate is ACK-dropped (ingest resolves with handled-terminal outcome)', async () => {
    const fileName = 'test-5mins-lv8.flac'
    const pathFile = path.join(__dirname, '../../test/', fileName)
    const tempFilePath = tempDirPath + fileName
    process.env.CACHE_DIRECTORY = tempDirPath
    fs.copyFile(pathFile, tempFilePath, (err) => { console.info(err) })
    const upload = await UploadModel.findOne({ checksum: UPLOAD.checksum })
    jest.spyOn(segmentService, 'createStreamFileData').mockRejectedValue(new IngestionError('Duplicate file. Matching sha1 signature already ingested.', status.DUPLICATE))

    // Must RESOLVE (so the consumer ACKs and does not dead-letter it).
    const result = await ingestService.ingest(`${UPLOAD.streamId}/${fileName}`, tempFilePath, UPLOAD.streamId, upload.id)
    expect(result).toBeDefined()
    expect(result.outcome).toBe('handled-terminal')
    expect(result.status).toBe(status.DUPLICATE)
    expect(storage.deleteObject).not.toHaveBeenCalled()
  })

  test('Handled-terminal preserves source upload for lifecycle expiry', async () => {
    const fileName = 'test-5mins-lv8.flac'
    const pathFile = path.join(__dirname, '../../test/', fileName)
    const tempFilePath = tempDirPath + fileName
    process.env.CACHE_DIRECTORY = tempDirPath
    fs.copyFile(pathFile, tempFilePath, (err) => { console.info(err) })
    const upload = await UploadModel.findOne({ checksum: UPLOAD.checksum })
    jest.spyOn(segmentService, 'createStreamFileData').mockRejectedValue(new IngestionError('Duplicate file. Matching sha1 signature already ingested.', status.DUPLICATE))

    const result = await ingestService.ingest(`${UPLOAD.streamId}/${fileName}`, tempFilePath, UPLOAD.streamId, upload.id)
    expect(result.outcome).toBe('handled-terminal')
    expect(storage.deleteObject).not.toHaveBeenCalled()
  })

  // --- s3-writer PUT-limit retry (2026-08-19) -------------------------------
  // The writer rejects segment PUTs with 503 SlowDown
  // "s3-writer in-flight PUT limit reached; retry" under bulkhead saturation.
  // These tests drive the REAL ingest pipeline (real transcode of the test
  // fixture) with storage.upload stubbed to emit that shape, asserting
  // (a) transient bursts self-heal into INGESTED with bounded retries,
  // (b) sustained saturation exhausts -> rollback + FAILED + re-throw (nack
  //     -> DLQ, redrivable) exactly as before the retry existed,
  // (c) non-throttle PUT failures keep their fail-fast single-attempt path.
  // Backoff knobs are env-shrunk so the suite doesn't sleep for real.

  function slowDown () {
    const err = new Error('s3-writer in-flight PUT limit reached; retry')
    err.code = 'SlowDown'
    err.statusCode = 503
    return err
  }

  function shrinkRetryKnobs (attempts = 3) {
    process.env.PUT_RETRY_ATTEMPTS = String(attempts)
    process.env.PUT_RETRY_BASE_MS = '1'
    process.env.PUT_RETRY_MAX_MS = '2'
    process.env.PUT_RETRY_MIN_MS = '1'
  }

  test('PUT-limit rejections are retried and the ingest still succeeds', async () => {
    const fileName = 'test-5mins-lv8.flac'
    const pathFile = path.join(__dirname, '../../test/', fileName)
    const tempFilePath = tempDirPath + fileName
    process.env.CACHE_DIRECTORY = tempDirPath
    shrinkRetryKnobs(3)
    fs.copyFile(pathFile, tempFilePath, (err) => { console.info(err) })
    const upload = await UploadModel.findOne({ checksum: UPLOAD.checksum })

    // First TWO segment PUTs hit the bulkhead, then every attempt succeeds
    // (the burst passed) — the 08-19 prod shape at ~12% failure rate.
    let calls = 0
    const uploadSpy = jest.spyOn(storage, 'upload').mockImplementation(() => {
      calls += 1
      if (calls <= 2) { return Promise.reject(slowDown()) }
      return Promise.resolve({ ETag: true })
    })

    await ingestService.ingest(`${UPLOAD.streamId}/${fileName}`, tempFilePath, UPLOAD.streamId, upload.id)

    const newUpload = await UploadModel.findOne({ checksum: UPLOAD.checksum })
    expect(newUpload.status).toBe(status.INGESTED)
    // 5 segments + 2 retried attempts = 7 total PUT calls; no rollback.
    expect(uploadSpy).toHaveBeenCalledTimes(7)
    expect(storage.deleteObject).not.toHaveBeenCalled()
  })

  // --- segment file_size must describe the STORED FLAC (2026-08-21) ---------
  // Regression: transcode() converts each split WAV segment to FLAC and updates
  // file.path, but did NOT refresh file.meta -- so the size reported to Core
  // (and thence to Arbimon's recordings.file_size) was the UNCOMPRESSED WAV
  // size, a constant sampleCount*2 + header for every segment of a given
  // length. Observed live 2026-08-21 on 97 freshly-uploaded recordings, all
  // reporting 5760258 bytes while the stored objects ranged 3.3-4.3 MB.
  //
  // NOTE ON THE MOCKS: the suite-wide beforeEach stubs audioService.convert to
  // return the SOURCE file's meta (size 6672949) and audioService.split to
  // return per-segment meta (size 1024+idx). The convert() stub is shared by
  // BOTH call sites -- the whole-file WAV conversion AND the per-segment FLAC
  // conversion -- so a naive assertion here reads the stub, not the code. This
  // test therefore re-stubs convert() per call so the segment conversions
  // return DISTINCT, segment-specific sizes, which is what the real ffprobe
  // does (verified: real FLAC segments of this fixture measure 15060/1070288/
  // 1830924/1867764/1980091 bytes -- all different).
  test('segment file_size is refreshed from the converted FLAC, not left as the WAV size', async () => {
    const fileName = 'test-5mins-lv8.flac'
    const pathFile = path.join(__dirname, '../../test/', fileName)
    const tempFilePath = tempDirPath + fileName
    process.env.CACHE_DIRECTORY = tempDirPath
    fs.copyFile(pathFile, tempFilePath, (err) => { console.info(err) })
    const upload = await UploadModel.findOne({ checksum: UPLOAD.checksum })

    jest.spyOn(storage, 'upload').mockResolvedValue({ ETag: true })

    // Distinct FLAC sizes per segment, mirroring reality. The first call is the
    // whole-file WAV conversion (source meta); later calls are the per-segment
    // FLAC conversions.
    const flacSizes = [15060, 1070288, 1830924, 1867764, 1980091]
    let convertCall = 0
    jest.spyOn(audioService, 'convert').mockImplementation(() => {
      const idx = convertCall++
      if (idx === 0) {
        return Promise.resolve({
          meta: { duration: 299.806032, sampleCount: 13221446, sampleRate: 48000, bitRate: 1, codec: 'pcm_s16le', size: 6672949, checksum: UPLOAD.checksum }
        })
      }
      return Promise.resolve({ meta: { duration: 60, sampleCount: 2880000, size: flacSizes[idx - 1] } })
    })

    await ingestService.ingest(`${UPLOAD.streamId}/${fileName}`, tempFilePath, UPLOAD.streamId, upload.id)

    expect(segmentService.createStreamFileData).toHaveBeenCalled()
    // createStreamFileData(stream, payload); payload is camelCase at this point
    // (it is transformed to snake_case inside the service).
    const payload = segmentService.createStreamFileData.mock.calls.slice(-1)[0][1]
    const segments = payload.streamSegments
    expect(Array.isArray(segments)).toBe(true)
    expect(segments.length).toBe(flacSizes.length)

    const reported = segments.map(s => Number(s.fileSize))
    // 1. each segment carries ITS OWN converted size ...
    expect(reported).toEqual(flacSizes)
    // 2. ... none is left at the split()-probed WAV size (1024 + idx) ...
    expect(reported.some((v, i) => v === 1024 + i)).toBe(false)
    // 3. ... and none is the whole-source size.
    expect(reported.includes(6672949)).toBe(false)
  })

  test('Exhausted PUT-limit retries roll back and nack exactly like before (bounded attempts)', async () => {
    const fileName = 'test-5mins-lv8.flac'
    const pathFile = path.join(__dirname, '../../test/', fileName)
    const tempFilePath = tempDirPath + fileName
    process.env.CACHE_DIRECTORY = tempDirPath
    shrinkRetryKnobs(3)
    fs.copyFile(pathFile, tempFilePath, (err) => { console.info(err) })
    const upload = await UploadModel.findOne({ checksum: UPLOAD.checksum })

    // Sustained saturation: every PUT attempt is rejected.
    const uploadSpy = jest.spyOn(storage, 'upload').mockRejectedValue(slowDown())

    // Must RE-THROW (consumer nacks to DLQ — transient class, redrivable).
    await expect(
      ingestService.ingest(`${UPLOAD.streamId}/${fileName}`, tempFilePath, UPLOAD.streamId, upload.id)
    ).rejects.toThrow(/in-flight PUT limit reached/)

    const newUpload = await UploadModel.findOne({ checksum: UPLOAD.checksum })
    expect(newUpload.status).toBe(status.FAILED)
    expect(newUpload.failureMessage).toBe('Server failed with processing your file. Please try again later.')
    // BOUNDED: 5 segments x 3 attempts each = 15, not unbounded.
    expect(uploadSpy).toHaveBeenCalledTimes(15)
    // Rollback ran: every registered segment was deleted.
    expect(storage.deleteObject).toHaveBeenCalledTimes(5)
    // Core rollback ran too (source file had been created).
    expect(segmentService.deleteStreamSourceFile).toHaveBeenCalledTimes(1)
  })

  test('Non-throttle PUT failure keeps the fail-fast single-attempt path', async () => {
    const fileName = 'test-5mins-lv8.flac'
    const pathFile = path.join(__dirname, '../../test/', fileName)
    const tempFilePath = tempDirPath + fileName
    process.env.CACHE_DIRECTORY = tempDirPath
    shrinkRetryKnobs(3)
    fs.copyFile(pathFile, tempFilePath, (err) => { console.info(err) })
    const upload = await UploadModel.findOne({ checksum: UPLOAD.checksum })

    const err = new Error('Access Denied')
    err.code = 'AccessDenied'
    err.statusCode = 403
    const uploadSpy = jest.spyOn(storage, 'upload').mockRejectedValue(err)

    await expect(
      ingestService.ingest(`${UPLOAD.streamId}/${fileName}`, tempFilePath, UPLOAD.streamId, upload.id)
    ).rejects.toThrow('Access Denied')

    const newUpload = await UploadModel.findOne({ checksum: UPLOAD.checksum })
    expect(newUpload.status).toBe(status.FAILED)
    // NO retry on non-throttle errors: exactly one attempt per segment in
    // the first parallel chunk of 5, none re-attempted.
    expect(uploadSpy).toHaveBeenCalledTimes(5)
  })

  test('Pre-transcode dedup ACK-drops (coreData empty => no rollback crash)', async () => {
    // Regression: the pre-transcode dedup path throws DUPLICATE BEFORE
    // createStreamFileData runs, leaving coreData = {} (truthy). The catch
    // must NOT attempt the Core rollback (coreData.streamSourceFile.id is
    // undefined) — doing so threw out of the catch and nacked the message.
    const fileName = 'test-5mins-lv8.flac'
    const pathFile = path.join(__dirname, '../../test/', fileName)
    const tempFilePath = tempDirPath + fileName
    process.env.CACHE_DIRECTORY = tempDirPath
    fs.copyFile(pathFile, tempFilePath, (err) => { console.info(err) })
    const upload = await UploadModel.findOne({ checksum: UPLOAD.checksum })
    // Pre-transcode dedup returns a genuine already-ingested match.
    const ts = new Date(UPLOAD.timestamp).toISOString()
    jest.spyOn(segmentService, 'findIngestedDuplicate').mockResolvedValue({
      id: 'existing-source-file-id',
      availability: 1,
      segments: [{ start: ts }]
    })
    const createSpy = jest.spyOn(segmentService, 'createStreamFileData')

    const result = await ingestService.ingest(`${UPLOAD.streamId}/${fileName}`, tempFilePath, UPLOAD.streamId, upload.id)
    // Resolved (ACK-drop), transcode/Core-create skipped, no nack/crash.
    expect(result.outcome).toBe('handled-terminal')
    expect(result.status).toBe(status.DUPLICATE)
    expect(createSpy).not.toHaveBeenCalled()
  })
})
