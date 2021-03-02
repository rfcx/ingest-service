const axios = require('axios')
const { matchAxiosErrorToRfcx } = require('../utils/errors')

const arbimonHost = process.env.ARBIMON_HOST

function createRecording (opts, idToken) {
  const url = `${arbimonHost}api/ingest/recordings/create`
  const data = {};
  ['project_id', 'site_external_id', 'uri', 'datetime', 'sample_rate', 'precision',
    'duration', 'samples', 'file_size', 'bit_rate', 'sample_encoding'].forEach(attr => data[attr] = opts[attr])
  const headers = {
    Authorization: idToken,
    'Content-Type': 'application/json'
  }

  return axios.post(url, data, { headers })
    .then(response => {
      return response.data
    })
    .catch(e => { throw matchAxiosErrorToRfcx(e) })
}

module.exports = {
  createRecording
}
