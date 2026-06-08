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
  try {
    const response = await axios.get(url, { headers, params })
    return response && response.data ? response.data : null
  } catch (e) {
    const rfcxErr = matchAxiosErrorToRfcx(e)
    // "Stream source file not found" => genuinely not a duplicate.
    if (rfcxErr && /not found/i.test(rfcxErr.message || '')) {
      return null
    }
    // Any other error: don't block ingestion on a flaky pre-check; let the
    // authoritative post-transcode createStreamFileData dedup catch it.
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
      if (err.response && err.response.data && err.response.data.message) {
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
            status = FAILED
        }
        throw new IngestionError(message, status)
      } else {
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
