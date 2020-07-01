const axios = require('axios');
const auth0Service = require('../auth0');

const apiHostName = process.env.API_HOST;

async function createStreamSourceFile (opts) {

  const url = `${apiHostName}streams/${opts.stream}/stream-source-files`
  const data = {
    filename: opts.filename,
    format: opts.format,
    duration: Math.abs(opts.duration * 1000),
    sample_count: opts.sampleCount,
    channel_layout: opts.channelLayout,
    channels_count: opts.channelCount,
    bit_rate: opts.bitRate,
    sample_rate: opts.sampleRate,
    codec: opts.codec,
    sha1_checksum: opts.sha1_checksum,
    meta: opts.tags,
  }

  const headers = {
    'Authorization': `Bearer ${opts.idToken}`,
    'Content-Type': 'application/json'
  }

  return axios.post(url, data, { headers })
}

async function deleteStreamSourceFile (opts) {

  const url = `${apiHostName}v2/streams/master-segments/${opts.guid}`

  const token = await auth0Service.getToken();
  const headers = {
    'Authorization': `Bearer ${token.access_token}`,
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
    file_extension: opts.file_extension,
  }

  const headers = {
    'Authorization': `Bearer ${opts.idToken}`,
    'Content-Type': 'application/json'
  }

  return axios.post(url, data, { headers })
}

async function deleteSegment (opts) {

  const url = `${apiHostName}stream-segments/${opts.guid}`
  const token = await auth0Service.getToken();
  const headers = {
    'Authorization': `Bearer ${token.access_token}`,
    'Content-Type': 'application/json'
  }

  return axios.delete(url, { headers })
}

module.exports = {
  createStreamSourceFile,
  deleteStreamSourceFile,
  createSegment,
  deleteSegment,
}
