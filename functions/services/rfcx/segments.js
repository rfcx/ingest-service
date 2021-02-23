const axios = require('axios')
const auth0Service = require('../auth0')
const { matchAxiosErrorToRfcx } = require('../../utils/errors')

const apiHostName = process.env.API_HOST

function getExistingSourceFiles (opts) {
  const url = `${apiHostName}streams/${opts.stream}/stream-source-files`
  const params = {
    'sha1_checksum[]': opts.checksum
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

async function createStreamSourceFile (opts) {
  const url = `${apiHostName}streams/${opts.stream}/stream-source-files`
  const data = {
    filename: opts.filename,
    audio_file_format: opts.format,
    duration: Math.abs(opts.duration * 1000),
    sample_count: opts.sampleCount,
    channels_count: opts.channelCount,
    bit_rate: opts.bitRate,
    sample_rate: opts.sampleRate,
    audio_codec: opts.codec,
    sha1_checksum: opts.sha1_checksum,
    meta: opts.tags
  }

  const headers = {
    Authorization: `Bearer ${opts.idToken}`,
    'Content-Type': 'application/json'
  }

  return axios.post(url, data, { headers })
}

async function deleteStreamSourceFile (opts) {
  const url = `${apiHostName}stream-source-files/${opts.guid}`

  const token = await auth0Service.getToken()
  const headers = {
    Authorization: `Bearer ${token.access_token}`,
    'Content-Type': 'application/json'
  }

  return axios.delete(url, { headers })
}

async function createSegment (opts) {
  const url = `${apiHostName}streams/${opts.stream}/stream-segments`
  const data = {
    id: opts.id,
    stream_source_file_id: opts.streamSourceFileId,
    start: opts.start,
    end: opts.end,
    sample_count: opts.sample_count,
    file_extension: opts.file_extension
  }

  const headers = {
    Authorization: `Bearer ${opts.idToken}`,
    'Content-Type': 'application/json'
  }

  return axios.post(url, data, { headers })
}

async function deleteSegment (opts) {
  const url = `${apiHostName}stream-segments/${opts.guid}`
  const token = await auth0Service.getToken()
  const headers = {
    Authorization: `Bearer ${token.access_token}`,
    'Content-Type': 'application/json'
  }

  return axios.delete(url, { headers })
}

module.exports = {
  getExistingSourceFiles,
  createStreamSourceFile,
  deleteStreamSourceFile,
  createSegment,
  deleteSegment
}
