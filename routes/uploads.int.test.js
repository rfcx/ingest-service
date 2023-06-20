process.env.PLATFORM = 'amazon'
process.env.UPLOAD_BUCKET = 'streams-uploads'

const storageModulePath = '../services/storage/amazon'
jest.mock(storageModulePath)
const { getSignedUrl } = require(storageModulePath)

const streamsModulePath = '../services/rfcx/streams'
jest.mock(streamsModulePath)
const { checkPermission } = require(streamsModulePath)

const segmentsModulePath = '../services/rfcx/segments'
jest.mock(segmentsModulePath)
const { getExistingSourceFile } = require(segmentsModulePath)

const { startDb, stopDb, truncateDbModels, expressApp, muteConsole, seedValues } = require('../utils/testing')
const request = require('supertest')

const app = expressApp()
const UploadModel = require('../services/db/models/mongoose/upload').Upload
const { status } = require('../services/db/mongo')
const { ForbiddenError, EmptyResultError } = require('@rfcx/http-utils')

const route = require('./uploads')
app.use('/uploads', route)

beforeAll(async () => {
  muteConsole()
  await startDb()
})
beforeEach(async () => {
  checkPermission.mockImplementation(() => {})
  getExistingSourceFile.mockImplementation(() => { throw new EmptyResultError('Stream source file not found') })
  getSignedUrl.mockImplementation(() => 'http://some.url')
  await truncateDbModels(UploadModel)
})
afterEach(async () => {
  checkPermission.mockRestore()
  getExistingSourceFile.mockRestore()
  getSignedUrl.mockRestore()
})
afterAll(async () => {
  await stopDb()
})

describe('POST /uploads', () => {
  test('returns validation error if filename is not set', async () => {
    const requestBody = {
      timestamp: '2021-06-08T19:26:40.000Z',
      stream: '0a1824085e3f',
      checksum: 'acd44fdcc42e0dad141f35ae1aa029fd6b3f9eca',
      sampleRate: 64000,
      targetBitrate: 1
    }
    const response = await request(app).post('/uploads').send(requestBody)
    expect(response.statusCode).toBe(400)
    expect(response.body.message).toEqual('Validation errors: Parameter \'filename\' the parameter is required but was not provided.')
  })
  test('returns validation error if timestamp is not set', async () => {
    const requestBody = {
      filename: '0a1824085e3f-2021-06-08T19-26-40.flac',
      stream: '0a1824085e3f',
      checksum: 'acd44fdcc42e0dad141f35ae1aa029fd6b3f9eca',
      sampleRate: 64000,
      targetBitrate: 1
    }
    const response = await request(app).post('/uploads').send(requestBody)
    expect(response.statusCode).toBe(400)
    expect(response.body.message).toEqual('Validation errors: Parameter \'timestamp\' the parameter is required but was not provided.')
  })
  test('returns validation error if stream is not set', async () => {
    const requestBody = {
      filename: '0a1824085e3f-2021-06-08T19-26-40.flac',
      timestamp: '2021-06-08T19:26:40.000Z',
      checksum: 'acd44fdcc42e0dad141f35ae1aa029fd6b3f9eca',
      sampleRate: 64000,
      targetBitrate: 1
    }
    const response = await request(app).post('/uploads').send(requestBody)
    expect(response.statusCode).toBe(400)
    expect(response.body.message).toEqual('Validation errors: Parameter \'stream\' the parameter is required but was not provided.')
  })
  test('returns validation error if request body is empty', async () => {
    const response = await request(app).post('/uploads')
    expect(response.statusCode).toBe(400)
    expect(response.body.message).toEqual('Validation errors: Parameter \'filename\' the parameter is required but was not provided; Parameter \'timestamp\' the parameter is required but was not provided; Parameter \'stream\' the parameter is required but was not provided.')
  })
  test('returns forbidden error if user does not have access to stream', async () => {
    checkPermission.mockImplementation(() => { throw new ForbiddenError() })
    const requestBody = {
      filename: '0a1824085e3f-2021-06-08T19-26-40.flac',
      timestamp: '2021-06-08T19:26:40.000Z',
      stream: '0a1824085e3f',
      checksum: 'acd44fdcc42e0dad141f35ae1aa029fd6b3f9eca',
      sampleRate: 64000,
      targetBitrate: 1
    }
    const response = await request(app).post('/uploads').send(requestBody)
    expect(response.statusCode).toBe(403)
  })
  test('returns empty error if stream does not exist', async () => {
    checkPermission.mockImplementation(() => { throw new EmptyResultError() })
    const requestBody = {
      filename: '0a1824085e3f-2021-06-08T19-26-40.flac',
      timestamp: '2021-06-08T19:26:40.000Z',
      stream: '0a1824085e3f',
      checksum: 'acd44fdcc42e0dad141f35ae1aa029fd6b3f9eca',
      sampleRate: 64000,
      targetBitrate: 1
    }
    const response = await request(app).post('/uploads').send(requestBody)
    expect(response.statusCode).toBe(404)
  })
  test('returns validation error with "Duplicate." message if file was already uploaded and has same filename', async () => {
    getExistingSourceFile.mockImplementation(() => { return { filename: '0a1824085e3f-2021-06-08T19-26-40.flac' } })
    const requestBody = {
      filename: '0a1824085e3f-2021-06-08T19-26-40.flac',
      timestamp: '2021-06-08T19:26:40.000Z',
      stream: '0a1824085e3f',
      checksum: 'acd44fdcc42e0dad141f35ae1aa029fd6b3f9eca',
      sampleRate: 64000,
      targetBitrate: 1
    }
    const response = await request(app).post('/uploads').send(requestBody)
    expect(response.statusCode).toBe(400)
    expect(response.body.message).toBe('Duplicate.')
  })
  test('returns validation error with "Invalid." message if file was already uploaded and has different filename', async () => {
    getExistingSourceFile.mockImplementation(() => { return { filename: '0a1824085e3f-2021-06-08T12-26-40.flac' } })
    const requestBody = {
      filename: '0a1824085e3f-2021-06-08T19-26-40.flac',
      timestamp: '2021-06-08T19:26:40.000Z',
      stream: '0a1824085e3f',
      checksum: 'acd44fdcc42e0dad141f35ae1aa029fd6b3f9eca',
      sampleRate: 64000,
      targetBitrate: 1
    }
    const response = await request(app).post('/uploads').send(requestBody)
    expect(response.statusCode).toBe(400)
    expect(response.body.message).toBe('Invalid.')
  })
  test('does not return validation error message if file was already uploaded but is unavailable', async () => {
    getExistingSourceFile.mockImplementation(() => { return { filename: '0a1824085e3f-2021-06-08T19-26-40.flac', availability: 0 } })
    const requestBody = {
      filename: '0a1824085e3f-2021-06-08T19-26-40.flac',
      timestamp: '2021-06-08T19:26:40.000Z',
      stream: '0a1824085e3f',
      checksum: 'acd44fdcc42e0dad141f35ae1aa029fd6b3f9eca',
      sampleRate: 64000,
      targetBitrate: 1
    }
    const response = await request(app).post('/uploads').send(requestBody)
    expect(response.statusCode).toBe(200)
  })
  test('creates upload document and returns correct data', async () => {
    const requestBody = {
      filename: '0a1824085e3f-2021-06-08T19-26-40.flac',
      timestamp: '2021-06-08T19:26:40.000Z',
      stream: '0a1824085e3f',
      checksum: 'acd44fdcc42e0dad141f35ae1aa029fd6b3f9eca',
      sampleRate: 64000,
      targetBitrate: 1
    }
    const response = await request(app).post('/uploads').send(requestBody)
    const upload = await UploadModel.findOne({ checksum: requestBody.checksum })
    expect(response.statusCode).toBe(200)
    expect(response.body.uploadId).toBeDefined()
    expect(response.body.url).toBe('http://some.url')
    expect(response.body.path).toBeDefined()
    expect(response.body.bucket).toBe('streams-uploads')
    expect(upload.originalFilename).toBe(requestBody.filename)
    expect(upload.streamId).toBe(requestBody.stream)
    expect(upload.userId).toBe(seedValues.primaryUserGuid)
    expect(upload.status).toBe(status.WAITING)
    expect(upload.timestamp.toISOString()).toEqual(requestBody.timestamp)
    expect(upload.sampleRate).toBe(requestBody.sampleRate)
    expect(upload.targetBitrate).toBe(requestBody.targetBitrate)
    expect(upload.checksum).toBe(requestBody.checksum)
  })
  test('creates upload document and returns correct data for guardian audio file', async () => {
    const requestBody = {
      filename: 'p0gccfokn3p9_2014-12-31T21-04-10.261-0300_24kHz_90.923secs.opus',
      timestamp: '2015-01-01T00:04:10.261Z',
      stream: 'p0gccfokn3p9',
      checksum: 'bcd44fdcc42e0dad141f35ae1aa029fd6b3f9eca',
      targetBitrate: 1
    }
    const response = await request(app).post('/uploads').send(requestBody)
    const upload = await UploadModel.findOne({ checksum: requestBody.checksum })
    expect(response.statusCode).toBe(200)
    expect(response.body.uploadId).toBeDefined()
    expect(response.body.url).toBe('http://some.url')
    expect(response.body.path).toBeDefined()
    expect(response.body.bucket).toBe('streams-uploads')
    expect(upload.originalFilename).toBe(requestBody.filename)
    expect(upload.streamId).toBe(requestBody.stream)
    expect(upload.userId).toBe(seedValues.primaryUserGuid)
    expect(upload.status).toBe(status.WAITING)
    expect(upload.timestamp.toISOString()).toEqual(requestBody.timestamp)
    expect(upload.sampleRate).toBe(24000)
    expect(upload.targetBitrate).toBe(requestBody.targetBitrate)
    expect(upload.checksum).toBe(requestBody.checksum)
  })
  test('saves sample rate from the filename only for opus format', async () => {
    const requestBody = {
      filename: 'p0gccfokn3p9_2014-12-31T21-04-10.261-0300_24kHz_90.923secs.flac',
      timestamp: '2015-01-01T00:04:10.261Z',
      stream: 'p0gccfokn3p9',
      checksum: 'bcd44fdcc42e0dad141f35ae1aa029fd6b3f9eca',
      targetBitrate: 1
    }
    const response = await request(app).post('/uploads').send(requestBody)
    const upload = await UploadModel.findOne({ checksum: requestBody.checksum })
    expect(response.statusCode).toBe(200)
    expect(upload.sampleRate).toBeUndefined()
  })
  test('saves sample rate from the filename only if it has valid format', async () => {
    const requestBody = {
      filename: 'p0gccfokn3p9_2014-12-31T21-04-10.261-0300_24kH_90.923secs.opus',
      timestamp: '2015-01-01T00:04:10.261Z',
      stream: 'p0gccfokn3p9',
      checksum: 'bcd44fdcc42e0dad141f35ae1aa029fd6b3f9eca',
      targetBitrate: 1
    }
    const response = await request(app).post('/uploads').send(requestBody)
    const upload = await UploadModel.findOne({ checksum: requestBody.checksum })
    expect(response.statusCode).toBe(200)
    expect(upload.sampleRate).toBeUndefined()
  })
  test('does not call segmentService.getExistingSourceFile if checksum is not provided', async () => {
    const requestBody = {
      filename: '0a1824085e3f-2021-06-08T19-26-40.flac',
      timestamp: '2021-06-08T19:26:40.000Z',
      stream: '0a1824085e3f',
      sampleRate: 64000,
      targetBitrate: 1
    }
    const response = await request(app).post('/uploads').send(requestBody)
    const upload = await UploadModel.findOne({ originalFilename: requestBody.filename })
    expect(response.statusCode).toBe(200)
    expect(response.body.uploadId).toBeDefined()
    expect(response.body.url).toBe('http://some.url')
    expect(response.body.path).toBeDefined()
    expect(response.body.bucket).toBe('streams-uploads')
    expect(upload.originalFilename).toBe(requestBody.filename)
    expect(upload.streamId).toBe(requestBody.stream)
    expect(upload.userId).toBe(seedValues.primaryUserGuid)
    expect(upload.status).toBe(status.WAITING)
    expect(upload.timestamp.toISOString()).toEqual(requestBody.timestamp)
    expect(upload.sampleRate).toBe(requestBody.sampleRate)
    expect(upload.targetBitrate).toBe(requestBody.targetBitrate)
    expect(upload.checksum).toBeUndefined()
    expect(getExistingSourceFile).toHaveBeenCalledTimes(0)
  })
  test('creates two upload documents and returns correct data for each', async () => {
    const requestBody = {
      filename: '0a1824085e3f-2021-06-08T19-26-40.flac',
      timestamp: '2021-06-08T19:26:40.000Z',
      stream: '0a1824085e3f',
      checksum: 'acd44fdcc42e0dad141f35ae1aa029fd6b3f9eca',
      sampleRate: 64000,
      targetBitrate: 1
    }
    const response = await request(app).post('/uploads').send(requestBody)
    const upload = await UploadModel.findOne({ checksum: requestBody.checksum })
    expect(response.statusCode).toBe(200)
    expect(response.body.uploadId).toBe(`${upload._id}`)
    expect(response.body.url).toBe('http://some.url')
    expect(response.body.path).toBe(`${requestBody.stream}/${upload._id}.flac`)
    expect(response.body.bucket).toBe('streams-uploads')
    expect(upload.originalFilename).toBe(requestBody.filename)
    expect(upload.streamId).toBe(requestBody.stream)
    expect(upload.userId).toBe(seedValues.primaryUserGuid)
    expect(upload.status).toBe(status.WAITING)
    expect(upload.timestamp.toISOString()).toEqual(requestBody.timestamp)
    expect(upload.sampleRate).toBe(requestBody.sampleRate)
    expect(upload.targetBitrate).toBe(requestBody.targetBitrate)
    expect(upload.checksum).toBe(requestBody.checksum)

    const requestBody2 = {
      filename: 'ed06231a6568-2021-06-08T20-30-00.flac',
      timestamp: '2021-06-08T20:30:00.000Z',
      stream: 'ed06231a6568',
      checksum: 'e5172bd92b59d520a4ca5b1be29cd6bdc92cc08a',
      sampleRate: 64000,
      targetBitrate: 1
    }
    const response2 = await request(app).post('/uploads').send(requestBody2)
    const upload2 = await UploadModel.findOne({ checksum: requestBody2.checksum })
    expect(response2.statusCode).toBe(200)
    expect(response2.body.uploadId).toBeDefined()
    expect(response2.body.url).toBe('http://some.url')
    expect(response2.body.path).toBeDefined()
    expect(response2.body.bucket).toBe('streams-uploads')
    expect(upload2.originalFilename).toBe(requestBody2.filename)
    expect(upload2.streamId).toBe(requestBody2.stream)
    expect(upload2.userId).toBe(seedValues.primaryUserGuid)
    expect(upload2.status).toBe(status.WAITING)
    expect(upload2.timestamp.toISOString()).toEqual(requestBody2.timestamp)
    expect(upload2.sampleRate).toBe(requestBody2.sampleRate)
    expect(upload2.targetBitrate).toBe(requestBody2.targetBitrate)
    expect(upload2.checksum).toBe(requestBody2.checksum)

    const uploads = await UploadModel.find({})
    expect(uploads.length).toBe(2)
  })
})

describe('GET /uploads/:id', () => {
  test('returns correct upload data', async () => {
    const dbUpload = await new UploadModel({
      streamId: '123456789012',
      userId: seedValues.primaryUserGuid,
      status: status.WAITING,
      timestamp: 1623163658922,
      originalFilename: '20210608144738922.flac',
      sampleRate: 12000,
      targetBitrate: 2921629,
      checksum: 'b40e6a5687c7ce2557ce48e131cc68c2889bfdc2'
    }).save()
    const id = `${dbUpload._id}` // ObjectId is an object, we need to stringify it
    const response = await request(app).get(`/uploads/${id}`)
    expect(response.statusCode).toBe(200)
    expect(response.body._id).toEqual(id)
    expect(response.body.streamId).toEqual('123456789012')
    expect(response.body.userId).toEqual(seedValues.primaryUserGuid)
    expect(response.body.status).toEqual(status.WAITING)
    expect(response.body.timestamp).toEqual('2021-06-08T14:47:38.922Z')
    expect(response.body.originalFilename).toEqual('20210608144738922.flac')
    expect(response.body.sampleRate).toEqual(12000)
    expect(response.body.targetBitrate).toEqual(2921629)
    expect(response.body.checksum).toEqual('b40e6a5687c7ce2557ce48e131cc68c2889bfdc2')
  })
  test('returns correct upload data for uploaded file', async () => {
    const dbUpload = await new UploadModel({
      streamId: 'aaabbbccc111',
      userId: seedValues.primaryUserGuid,
      status: status.UPLOADED,
      timestamp: 1623179971843,
      originalFilename: '20210608191931843.flac',
      sampleRate: 24000,
      targetBitrate: 2949185,
      checksum: 'rrtt6a5687c7ce2557ce48e131cc68c2889bfdc2'
    }).save()
    const id = `${dbUpload._id}` // ObjectId is an object, we need to stringify it
    const response = await request(app).get(`/uploads/${id}`)
    expect(response.statusCode).toBe(200)
    expect(response.body._id).toEqual(id)
    expect(response.body.streamId).toEqual('aaabbbccc111')
    expect(response.body.userId).toEqual(seedValues.primaryUserGuid)
    expect(response.body.status).toEqual(status.UPLOADED)
    expect(response.body.timestamp).toEqual('2021-06-08T19:19:31.843Z')
    expect(response.body.originalFilename).toEqual('20210608191931843.flac')
    expect(response.body.sampleRate).toEqual(24000)
    expect(response.body.targetBitrate).toEqual(2949185)
    expect(response.body.checksum).toEqual('rrtt6a5687c7ce2557ce48e131cc68c2889bfdc2')
  })
  test('returns not found error', async () => {
    const response = await request(app).get('/uploads/123456789010')
    expect(response.statusCode).toBe(404)
    expect(response.body._id).toBeUndefined()
  })
  test('returns not found error when id has incorrect number format', async () => {
    const response = await request(app).get('/uploads/1234')
    expect(response.statusCode).toBe(404)
    expect(response.body._id).toBeUndefined()
  })
  test('returns not found error when id has incorrect text format', async () => {
    const response = await request(app).get('/uploads/xyz')
    expect(response.statusCode).toBe(404)
    expect(response.body._id).toBeUndefined()
  })
  test('returns forbidden error for upload which is not yours', async () => {
    const dbUpload = await new UploadModel({
      streamId: '123456789012',
      userId: seedValues.otherUserId,
      status: status.WAITING,
      timestamp: 1623176591751,
      originalFilename: '20210608182311751.flac',
      sampleRate: 12000,
      targetBitrate: 2921629,
      checksum: 'b40e6a5687c7ce2557ce48e131cc68c2889bfdc3'
    }).save()
    const id = `${dbUpload._id}` // ObjectId is an object, we need to stringify it
    const response = await request(app).get(`/uploads/${id}`)
    expect(response.statusCode).toBe(403)
    expect(response.body._id).toBeUndefined()
  })
})
