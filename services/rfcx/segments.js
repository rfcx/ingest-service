const axios = require('axios')
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
        streamSourceFileId: response.headers.location.replace('/stream-source-files/', ''),
        streamSegments: response.data.stream_segments
      }
    })
    .catch((err) => {
      if (err.response && err.response.data && err.response.data.message) {
        const message = err.response.data.message
        let status
        switch (message) {
          case 'Duplicate file. Matching sha1 signature already ingested.':
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

async function deleteStreamSourceFile (id) {
  const url = `${apiHostName}stream-source-files/${id}`

  const token = await auth0Service.getToken()
  const headers = {
    Authorization: `Bearer ${token.access_token}`,
    'Content-Type': 'application/json'
  }

  return axios.delete(url, { headers })
}

module.exports = {
  getExistingSourceFile,
  createStreamFileData,
  deleteStreamSourceFile
}
