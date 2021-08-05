const axios = require('axios')
const { matchAxiosErrorToRfcx } = require('../../utils/errors')

const apiHostName = process.env.API_HOST

async function query (idToken, opts) {
  const url = `${apiHostName}projects`
  const params = {
    fields: ['id', 'name', 'permissions'],
    keyword: opts.keyword,
    limit: opts.limit,
    offset: opts.offset
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
