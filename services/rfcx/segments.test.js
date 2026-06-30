/* eslint-disable no-unused-vars */
const axios = require('../../utils/axios')
const segmentService = require('./segments')
const auth0Service = require('../auth0')
const { status } = require('../../services/db/mongo')
const { IngestionError } = require('../../utils/errors')

// createStreamFileData() maps a Core-API error response to either:
//   - a TERMINAL IngestionError (4xx: duplicate / already-ingested / etc.)
//     -> ingest.js ACK-drops + deletes the source upload, OR
//   - a re-thrown raw/transient error (5xx / no response)
//     -> ingest.js PRESERVES the source upload + nacks to the DLQ for redrive.
//
// Regression guard for the 2026-06-30 data-loss incident: a Core 500 (body
// message "Failed creating stream source file and segments") was being mapped
// to IngestionError(FAILED) = handled-terminal = ack-drop + DELETE source,
// silently destroying 115 originals. A 5xx MUST be treated as transient.

const STREAM = 'abcdef123456'
const PAYLOAD = { streamSourceFile: {}, streamSegments: [] }

beforeAll(() => {
  jest.spyOn(auth0Service, 'getToken').mockResolvedValue({ access_token: 'test-token' })
})
afterEach(() => {
  jest.restoreAllMocks()
  jest.spyOn(auth0Service, 'getToken').mockResolvedValue({ access_token: 'test-token' })
})

function axiosError (httpStatus, message) {
  const err = new Error(`Request failed with status code ${httpStatus}`)
  err.response = { status: httpStatus, data: message === undefined ? {} : { message } }
  return err
}

describe('createStreamFileData error classification', () => {
  test('Core 500 -> transient: re-throws raw (NOT IngestionError) so source is preserved + DLQ', async () => {
    jest.spyOn(axios, 'post').mockRejectedValue(
      axiosError(500, 'Failed creating stream source file and segments')
    )
    await expect(segmentService.createStreamFileData(STREAM, PAYLOAD)).rejects.toThrow()
    let thrown
    try { await segmentService.createStreamFileData(STREAM, PAYLOAD) } catch (e) { thrown = e }
    expect(thrown).toBeDefined()
    expect(thrown).not.toBeInstanceOf(IngestionError)
  })

  test('Core 503 -> transient: re-throws raw (NOT IngestionError)', async () => {
    jest.spyOn(axios, 'post').mockRejectedValue(axiosError(503, 'Service Unavailable'))
    let thrown
    try { await segmentService.createStreamFileData(STREAM, PAYLOAD) } catch (e) { thrown = e }
    expect(thrown).not.toBeInstanceOf(IngestionError)
  })

  test('No response (network error) -> transient: re-throws raw', async () => {
    const netErr = new Error('ECONNRESET')
    jest.spyOn(axios, 'post').mockRejectedValue(netErr)
    let thrown
    try { await segmentService.createStreamFileData(STREAM, PAYLOAD) } catch (e) { thrown = e }
    expect(thrown).not.toBeInstanceOf(IngestionError)
    expect(thrown).toBe(netErr)
  })

  test('Core 400 duplicate -> terminal IngestionError(DUPLICATE)', async () => {
    jest.spyOn(axios, 'post').mockRejectedValue(
      axiosError(400, 'Duplicate file. Matching sha1 signature already ingested.')
    )
    let thrown
    try { await segmentService.createStreamFileData(STREAM, PAYLOAD) } catch (e) { thrown = e }
    expect(thrown).toBeInstanceOf(IngestionError)
    expect(thrown.status).toBe(status.DUPLICATE)
  })

  test('Core 400 already-ingested -> terminal IngestionError(INGESTED)', async () => {
    jest.spyOn(axios, 'post').mockRejectedValue(
      axiosError(400, 'This file was already ingested.')
    )
    let thrown
    try { await segmentService.createStreamFileData(STREAM, PAYLOAD) } catch (e) { thrown = e }
    expect(thrown).toBeInstanceOf(IngestionError)
    expect(thrown.status).toBe(status.INGESTED)
  })

  test('Unrecognized 4xx -> terminal IngestionError(FAILED) (non-retryable client error)', async () => {
    jest.spyOn(axios, 'post').mockRejectedValue(axiosError(403, 'Some other client error'))
    let thrown
    try { await segmentService.createStreamFileData(STREAM, PAYLOAD) } catch (e) { thrown = e }
    expect(thrown).toBeInstanceOf(IngestionError)
    expect(thrown.status).toBe(status.FAILED)
  })
})
