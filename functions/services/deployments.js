const axios = require('axios')
const { matchAxiosErrorToRfcx } = require('../utils/errors')
const apiHostName = process.env.DEVICE_API_HOST

async function get (id, idToken) {
  const url = `${apiHostName}deployments/${id}`
  const headers = {
    Authorization: `${idToken}`,
    'Content-Type': 'application/json'
  }

  return axios.get(url, { headers })
    .then(response => response.data)
    .catch(e => { throw matchAxiosErrorToRfcx(e) })
}

module.exports = {
  get
}
