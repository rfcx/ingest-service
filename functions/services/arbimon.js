const axios = require('axios')
const { matchAxiosErrorToRfcx } = require('../utils/errors')
const auth0Service = require('./auth0')

const arbimonHost = process.env.ARBIMON_HOST

async function createRecordingsFromFiles (outputFiles, upload) {
  let totalDurationMs = 0
  for (const file of outputFiles) {
    const duration = file.meta.duration
    const recording = {
      site_external_id: upload.streamId,
      uri: file.remotePath,
      datetime: file.start,
      sample_rate: upload.sampleRate || file.meta.sampleRate,
      precision: 0,
      duration,
      samples: file.meta.sampleCount,
      file_size: file.meta.size,
      bit_rate: upload.targetBitrate || file.meta.bitRate,
      sample_encoding: file.meta.codec
    }
    totalDurationMs += duration
    console.log(`Creating recording ${recording.uri} in the Arbimon`, recording)
    await createRecording(recording)
  }
}

async function createRecording (opts) {
  const url = `${arbimonHost}api/ingest/recordings/create`
  const data = {};
  ['project_id', 'site_external_id', 'uri', 'datetime', 'sample_rate', 'precision',
    'duration', 'samples', 'file_size', 'bit_rate', 'sample_encoding'].forEach(attr => data[attr] = opts[attr])

  const token = await auth0Service.getToken()
  const headers = {
    Authorization: `Bearer ${token.access_token}`,
    'Content-Type': 'application/json'
  }

  return axios.post(url, data, { headers })
    .then(response => {
      return response.data
    })
    .catch(e => { throw matchAxiosErrorToRfcx(e) })
}

module.exports = {
  createRecordingsFromFiles,
  createRecording
}
