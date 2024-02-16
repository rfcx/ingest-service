/* eslint-disable no-unused-vars */
const ingestService = require('./ingest')
const path = require('path')
const fs = require('fs')
const platform = process.env.PLATFORM || 'amazon'
const storage = require(`../storage/${platform}`)
const segmentService = require('../rfcx/segments')
const { status } = require('../../services/db/mongo')
const { rimraf } = require('rimraf')

const originalEnv = process.env

const { startDb, stopDb, truncateDbModels, muteConsole, seedValues } = require('../../utils/testing')
const { IngestionError } = require('../../utils/errors')

const UploadModel = require('../../services/db/models/mongoose/upload').Upload

const UPLOAD = { id: 1, originalFilename: '0a1824085e3f-2021-06-08T19-26-40.flac', timestamp: '2021-06-08T19:26:40.000Z', streamId: '0a1824085e3f', checksum: 'c0cdd1156b69c8255ff83b9eb0ba6412cced8411', sampleRate: 48000, targetBitrate: 1, duration: 250000 }

beforeAll(async () => {
  muteConsole('warn')
  await startDb()
})
beforeEach(async () => {
  await truncateDbModels(UploadModel)
  await UploadModel(UPLOAD).save()
  jest.spyOn(storage, 'download').mockReturnValue('')
  jest.spyOn(storage, 'upload').mockReturnValue(Promise.resolve({ ETag: true }))
  jest.spyOn(storage, 'deleteObject').mockReturnValue('')
  jest.spyOn(storage, 'copy').mockReturnValue('')
  jest.spyOn(storage, 'createFromData').mockReturnValue('')
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
})
afterAll(async () => {
  await stopDb()
})

describe('Test ingest service', () => {
  test('Can ingest audio', async () => {
    const fileName = 'test-5mins-lv8.flac'
    const pathFile = path.join(__dirname, '../../test/', fileName)
    const tempDirPath = path.join(__dirname, '../../test/tmp/')
    const tempFilePath = tempDirPath + fileName
    process.env.CACHE_DIRECTORY = tempDirPath
    // remove all remaining temp files
    await rimraf(tempDirPath + '*', { glob: true })
    // copy test file to tmp dir
    fs.copyFile(pathFile, tempFilePath, (err) => {
      console.info(err)
    })
    const upload = await UploadModel.findOne({ checksum: UPLOAD.checksum })

    await ingestService.ingest(`${UPLOAD.streamId}/${fileName}`, tempFilePath, UPLOAD.streamId, upload.id)

    const newUpload = await UploadModel.findOne({ checksum: UPLOAD.checksum })
    expect(newUpload.status).toBe(status.INGESTED)
  })

  test('Checksum error', async () => {
    const fileName = 'test-1min-lv8.flac'
    const pathFile = path.join(__dirname, '../../test/', fileName)
    const tempDirPath = path.join(__dirname, '../../test/tmp/')
    const tempFilePath = tempDirPath + fileName
    process.env.CACHE_DIRECTORY = tempDirPath
    // remove all remaining temp files
    await rimraf(tempDirPath + '*', { glob: true })
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
    const tempDirPath = path.join(__dirname, '../../test/tmp/')
    const tempFilePath = tempDirPath + fileName
    process.env.CACHE_DIRECTORY = tempDirPath
    // remove all remaining temp files
    await rimraf(tempDirPath + '*', { glob: true })
    // copy test file to tmp dir
    fs.copyFile(pathFile, tempFilePath, (err) => {
      console.info(err)
    })
    const upload = await UploadModel.findOne({ checksum: UPLOAD.checksum })

    await ingestService.ingest(`${UPLOAD.streamId}/${fileName}`, tempFilePath, UPLOAD.streamId, upload.id)

    const newUpload = await UploadModel.findOne({ checksum: UPLOAD.checksum })
    expect(newUpload.status).toBe(status.FAILED)
    expect(newUpload.failureMessage).toBe('Server failed with processing your file. Please try again later.')
  })

  test('Duplicate error', async () => {
    const fileName = 'test-5mins-lv8.flac'
    const pathFile = path.join(__dirname, '../../test/', fileName)
    const tempDirPath = path.join(__dirname, '../../test/tmp/')
    const tempFilePath = tempDirPath + fileName
    process.env.CACHE_DIRECTORY = tempDirPath
    // remove all remaining temp files
    await rimraf(tempDirPath + '*', { glob: true })
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
})
