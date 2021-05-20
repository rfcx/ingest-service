const axios = require('axios')
const { matchAxiosErrorToRfcx } = require('../../utils/errors')

const apiHostName = process.env.API_HOST

async function query (idToken, opts) {
  const url = `${apiHostName}projects`
  const params = {
    ...opts.keyword !== undefined && { keyword: opts.keyword },
    ...opts.limit !== undefined && { limit: opts.limit },
    ...opts.offset !== undefined && { offset: opts.offset }
  }
  const headers = {
    Authorization: `${idToken}`,
    'Content-Type': 'application/json'
  }

  return axios.get(url, { headers, params })
    .catch(e => { throw matchAxiosErrorToRfcx(e) })
}

module.exports = {
  query
}
