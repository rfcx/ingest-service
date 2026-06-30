const axios = require('../../utils/axios')
const auth0Service = require('../auth0')
const { matchAxiosErrorToRfcx, IngestionError } = require('../../utils/errors')
const { status } = require('../db/mongo')
const { DUPLICATE, INGESTED, FAILED } = status

const apiHostName = process.env.API_HOST

function getExistingSourceFile (opts) {
  const url = `${apiHostName}internal/ingest/streams/${opts.stream}/stream-source-file`
  const params = {
    sha1_checksum: opts.checksum,
    start: opts.timestamp.toISOString()
  }
  if (opts.limit) {
    params.limit = opts.limit
  }

  const headers = {
    Authorization: opts.idToken,
    'Content-Type': 'application/json'
  }

  return axios.get(url, { headers, params })
    .then((response) => response.data)
    .catch(e => { throw matchAxiosErrorToRfcx(e) })
}

/**
 * Pre-transcode duplicate check. Looks up an existing stream source file by
 * (stream, sha1_checksum, start-timestamp) in Core. Unlike getExistingSourceFile
 * this fetches its own auth token (like createStreamFileData) so the task
 * consumer can call it directly after ffmpeg-identify and BEFORE transcoding,
 * to skip the expensive transcode + segment-upload when the original file was
 * already ingested. Returns the existing source file object on a match, or
 * null if not found. Non-404 errors propagate (caller decides; we let the
 * authoritative post-transcode createStreamFileData check be the backstop).
 *
 * @param {string} stream     stream id
 * @param {string} checksum   sha1 of the ORIGINAL file (fileData.checksum)
 * @param {Date|moment} timestamp  upload timestamp
 */
async function findIngestedDuplicate (stream, checksum, timestamp) {
  if (!checksum) {
    return null
  }
  // Entire body (incl. token fetch) is guarded: this is a best-effort
  // optimization, so ANY failure (auth, network, not-found) must return
  // null and never block ingestion. The authoritative post-transcode
  // createStreamFileData dedup is the real guarantee.
  try {
    const url = `${apiHostName}internal/ingest/streams/${stream}/stream-source-file`
    const token = await auth0Service.getToken()
    const params = {
      sha1_checksum: checksum,
      start: (timestamp && timestamp.toISOString) ? timestamp.toISOString() : timestamp
    }
    const headers = {
      Authorization: `Bearer ${token.access_token}`,
      'Content-Type': 'application/json'
    }
    const response = await axios.get(url, { headers, params })
    return response && response.data ? response.data : null
  } catch (e) {
    return null
  }
}

function transformStreamSourceFilePayload (data) {
  return {
    filename: data.filename,
    audio_file_format: data.format,
    duration: Math.abs(data.duration * 1000),
    sample_count: data.sampleCount,
    channels_count: data.channelCount,
    bit_rate: data.bitRate,
    sample_rate: data.sampleRate,
    audio_codec: data.codec,
    sha1_checksum: data.checksum,
    meta: data.tags
  }
}

function transformStreamSegmentsPayload (data) {
  return data.map(item => {
    return {
      id: item.id,
      start: item.start,
      end: item.end,
      sample_count: item.sampleCount,
      file_extension: item.fileExtension,
      file_size: item.fileSize
    }
  })
}

async function createStreamFileData (stream, payload) {
  const url = `${apiHostName}internal/ingest/streams/${stream}/stream-source-file-and-segments`
  const data = {
    stream_source_file: transformStreamSourceFilePayload(payload.streamSourceFile),
    stream_segments: transformStreamSegmentsPayload(payload.streamSegments)
  }

  const token = await auth0Service.getToken()
  const headers = {
    Authorization: `Bearer ${token.access_token}`,
    'Content-Type': 'application/json'
  }

  return axios.post(url, data, { headers })
    .then((response) => {
      if (!response || response.status !== 201) {
        throw new Error('Stream source file was not created')
      }
      return {
        streamSourceFile: response.data.stream_source_file,
        streamSegments: response.data.stream_segments
      }
    })
    .catch((err) => {
      // Only map a Core response to a TERMINAL IngestionError when it is a
      // genuinely non-retryable client error (HTTP 4xx). Core signals the
      // terminal cases as ValidationError (400) / ForbiddenError (403):
      // duplicate, already-ingested, same-timestamp. A 5xx (or any error with
      // no response, e.g. a network blip) is TRANSIENT and MUST be re-thrown
      // raw so ingest.js classifies it as non-terminal -> preserve the source
      // upload + nack to the DLQ for redrive. Previously this switch keyed
      // ONLY on the response message with `default: FAILED`, so a Core 500
      // (body message 'Failed creating stream source file and segments')
      // became IngestionError(FAILED) -> handled-terminal -> the consumer
      // ack-dropped the message AND deleted the R2 source = silent data loss.
      // That destroyed 115 originals during the 2026-06-30 MariaDB-failover
      // sql_mode incident (core-api 500 on every legacy recordings INSERT).
      const statusCode = err.response && err.response.status
      const isClientError = typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500
      if (isClientError && err.response.data && err.response.data.message) {
        const message = err.response.data.message
        let status
        switch (message) {
          case 'Duplicate file. Matching sha1 signature already ingested.':
          case 'Cannot create source file with provided data.':
          case 'There is another file with the same timestamp in the stream.':
            status = DUPLICATE
            break
          case 'This file was already ingested.':
            status = INGESTED
            break
          default:
            // An unrecognized 4xx is still a non-retryable client error;
            // record it terminally rather than redriving forever.
            status = FAILED
        }
        throw new IngestionError(message, status)
      } else {
        // 5xx / no-response / unknown => transient. Re-throw raw so ingest.js
        // preserves the source upload and nacks the message to the DLQ.
        throw err
      }
    })
}

async function deleteStreamSourceFile (stream, payload) {
  const url = `${apiHostName}internal/ingest/streams/${stream}/stream-source-file-and-segments`
  const data = {
    stream_source_file: {
      id: payload.streamSourceFile.id
    },
    stream_segments: payload.streamSegments.map(s => {
      return {
        id: s.id,
        start: s.start,
        path: s.remotePath
      }
    })
  }

  const token = await auth0Service.getToken()
  const headers = {
    Authorization: `Bearer ${token.access_token}`,
    'Content-Type': 'application/json'
  }

  return axios.delete(url, { data, headers })
}

module.exports = {
  getExistingSourceFile,
  findIngestedDuplicate,
  createStreamFileData,
  deleteStreamSourceFile
}
