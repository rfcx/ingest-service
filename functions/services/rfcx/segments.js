const axios = require('axios')

const apiHostName = process.env.API_HOST

async function createMasterSegment (opts) {

  const url = `${apiHostName}v2/streams/${opts.stream}/master-segments`
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

async function createSegment (opts) {

  const url = `${apiHostName}v2/streams/${opts.stream}/segments`
  const data = {
    guid: opts.guid,
    master_segment: opts.masterSegment,
    starts: opts.starts,
    ends: opts.ends,
    sample_count: opts.sample_count,
    file_extension: opts.file_extension,
  }

  const headers = {
    'Authorization': `Bearer ${opts.idToken}`,
    'Content-Type': 'application/json'
  }

  return axios.post(url, data, { headers })
}

module.exports = {
  createMasterSegment,
  createSegment,
}
