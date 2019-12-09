const axios = require('axios')

const apiHostName = process.env.API_HOST

async function createMasterSegment (opts) {

  const url = apiHostName + 'v2/streams/master-segment'
  const data = {
    guid: opts.guid,
    filename: opts.filename,
    format: opts.format,
    duration: Math.abs(opts.duration * 1000),
    sample_count: opts.sampleCount,
    channel_layout: opts.channelLayout,
    channels_count: opts.channelCount,
    bit_rate: opts.bitRate,
    sample_rate: opts.sampleRate,
    codec: opts.codec
  }

  const headers = {
    'Authorization': opts.idToken,
    'Content-Type': 'application/json'
  }

  return axios.post(url, data, { headers })
}

module.exports = {
  createMasterSegment,
}
