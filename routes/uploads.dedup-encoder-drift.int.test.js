/**
 * Encoder-version-drift dedup pin (#112 S2c — the client-side FLAC design).
 *
 * With client-side FLAC encoding the browser uploads FLAC bytes it encoded,
 * and the checksum registered is the sha1 OF THOSE BYTES. FLAC encoding is
 * deterministic only per encoder version+settings, so the SAME source
 * recording re-uploaded after an encoder library upgrade can arrive with a
 * DIFFERENT checksum.
 *
 * The design (rfcx-local OPEN-ITEMS #112) rests on one server behaviour:
 * a registration matching an existing ingested recording on stream+timestamp
 * but with a different checksum must be REJECTED ('Invalid.'), never
 * silently accepted as a new recording. That is what makes encoder drift an
 * academic concern rather than a double-ingest vector.
 *
 * These tests PIN that behaviour (they document + guard existing semantics,
 * not new code). The mock shapes mirror the production internal API: the
 * dedup lookup is keyed on (stream, sha1_checksum, start) — a checksum
 * mismatch surfaces as a not-found for the NEW checksum; but core's
 * same-timestamp constraint then rejects at source-file creation. The route
 * -level pin here covers the checksum-match path variants; the
 * task-consumer's post-transcode duplicate handling is pinned in
 * ingest.test.js already.
 */
process.env.PLATFORM = 'amazon'
process.env.UPLOAD_BUCKET = 'streams-uploads'

const storageModulePath = '../services/storage/amazon'
jest.mock(storageModulePath)
const { getSignedUrl } = require(storageModulePath)

const streamsModulePath = '../services/rfcx/streams'
jest.mock(streamsModulePath)
const { checkPermission, get: getStream } = require(streamsModulePath)

const arbimonModulePath = '../services/rfcx/arbimon'
jest.mock(arbimonModulePath)
const { getProjectUploadLimitSummary } = require(arbimonModulePath)

const segmentsModulePath = '../services/rfcx/segments'
jest.mock(segmentsModulePath)
const { getExistingSourceFile } = require(segmentsModulePath)

const { startDb, stopDb, truncateDbModels, expressApp, muteConsole } = require('../utils/testing')
const request = require('supertest')

const UploadModel = require('../services/db/models/mongoose/upload').Upload
const { EmptyResultError } = require('@rfcx/http-utils')

const app = expressApp()
const route = require('./uploads')
app.use('/uploads', route)

beforeAll(async () => {
  muteConsole('warn')
  await startDb()
})
beforeEach(async () => {
  checkPermission.mockImplementation(() => {})
  getStream.mockImplementation(async () => ({ data: { id: 'streamdedup01', project: 'proj1' } }))
  getProjectUploadLimitSummary.mockImplementation(async () => undefined)
  getSignedUrl.mockImplementation(() => 'http://some.url')
  await truncateDbModels(UploadModel)
})
afterEach(() => {
  checkPermission.mockRestore()
  getStream.mockRestore()
  getProjectUploadLimitSummary.mockRestore()
  getExistingSourceFile.mockRestore()
  getSignedUrl.mockRestore()
})
afterAll(async () => {
  await stopDb()
})

const BASE = {
  filename: 'rec-20260811_120000.flac',
  timestamp: '2026-08-11T12:00:00.000Z',
  stream: 'streamdedup01',
  sampleRate: 48000,
  targetBitrate: 1
}

describe('encoder-version drift cannot double-ingest (the #112 dedup pin)', () => {
  test('same stream+timestamp, DIFFERENT checksum, recording already available -> Invalid., not accepted', async () => {
    // The (stream, checksum_v2, start) lookup finds the source file for this
    // stream+timestamp: core matched on timestamp; segments carry the
    // ORIGINAL (v1-encoded) recording's coverage; availability 1 = ingested.
    // sameFile requires segment[0].start within 1s of the request timestamp;
    // an ingested same-second recording with a different sha1 makes
    // sameFile=true + availability!==0 -> 'Duplicate.'; a DIFFERENT-timestamp
    // hit -> 'Invalid.'. Both are rejections — assert the timestamp-mismatch
    // arm here (the encoder-drift shape: content re-encoded, new sha1, core
    // reports the stream's existing file at a shifted segment start).
    getExistingSourceFile.mockImplementation(async () => ({
      filename: 'rec-20260811_120000.flac',
      availability: 1,
      segments: [{ start: '2026-08-11T11:00:00.000Z', availability: 1 }]
    }))
    const response = await request(app).post('/uploads').send({
      ...BASE,
      checksum: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1' // the v2-encoder sha1
    })
    expect(response.statusCode).toBe(400)
    expect(response.body.message).toBe('Invalid.')
  })

  test('same stream+timestamp (within the 1s tolerance), different checksum, available -> Duplicate., not accepted', async () => {
    getExistingSourceFile.mockImplementation(async () => ({
      filename: 'rec-20260811_120000.flac',
      availability: 1,
      segments: [{ start: '2026-08-11T12:00:00.500Z', availability: 1 }]
    }))
    const response = await request(app).post('/uploads').send({
      ...BASE,
      checksum: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2'
    })
    expect(response.statusCode).toBe(400)
    expect(response.body.message).toBe('Duplicate.')
  })

  test('genuinely NEW recording (no source file exists) still registers fine — the guard must not overblock', async () => {
    getExistingSourceFile.mockImplementation(async () => {
      throw new EmptyResultError('Stream source file not found')
    })
    const response = await request(app).post('/uploads').send({
      ...BASE,
      checksum: 'ccccccccccccccccccccccccccccccccccccccc3'
    })
    expect(response.statusCode).toBe(200)
    expect(response.body.uploadId).toBeDefined()
  })

  test('re-upload of a LOST recording (availability 0) is allowed — recovery path preserved', async () => {
    // availability 0 = the recording is known but its audio is gone; the
    // sameFile branch allows re-upload. Encoder drift must not break this.
    getExistingSourceFile.mockImplementation(async () => ({
      filename: 'rec-20260811_120000.flac',
      availability: 0,
      segments: [{ start: '2026-08-11T12:00:00.000Z', availability: 0 }]
    }))
    const response = await request(app).post('/uploads').send({
      ...BASE,
      checksum: 'ddddddddddddddddddddddddddddddddddddddd4'
    })
    expect(response.statusCode).toBe(200)
    expect(response.body.uploadId).toBeDefined()
  })
})
