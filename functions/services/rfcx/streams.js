const axios = require('axios')
const { matchAxiosErrorToRfcx } = require('../../utils/errors')

const apiHostName = process.env.API_HOST

function combineRequestPayload (opts) {
  return {
    ...opts.name !== undefined && { name: opts.name },
    ...opts.latitude !== undefined && { latitude: opts.latitude },
    ...opts.longitude !== undefined && { longitude: opts.longitude },
    ...opts.altitude !== undefined && { altitude: opts.altitude },
    ...opts.description !== undefined && { description: opts.description },
    ...opts.is_public !== undefined && { is_public: opts.is_public },
    ...opts.project_id !== undefined && { project_id: opts.project_id }
  }
}

async function create (opts) {
  const url = `${apiHostName}streams`
  const data = combineRequestPayload(opts)

  const headers = {
    Authorization: opts.idToken,
    'Content-Type': 'application/json'
  }

  return axios.post(url, data, { headers })
    .catch(e => { throw matchAxiosErrorToRfcx(e) })
}

async function update (opts) {
  const url = `${apiHostName}streams/${opts.streamId}`
  const data = combineRequestPayload(opts)

  const headers = {
    Authorization: opts.idToken,
    'Content-Type': 'application/json'
  }

  return axios.patch(url, data, { headers })
    .catch(e => { throw matchAxiosErrorToRfcx(e) })
}

async function remove (opts) {
  const url = `${apiHostName}streams/${opts.streamId}`
  const headers = {
    Authorization: opts.idToken,
    'Content-Type': 'application/json'
  }

  return axios.delete(url, { headers })
    .catch(e => { throw matchAxiosErrorToRfcx(e) })
}

async function query (idToken, params) {
  const url = `${apiHostName}streams`

  const headers = {
    Authorization: `${idToken}`,
    'Content-Type': 'application/json'
  }

  return axios.get(url, { headers, params })
    .catch(e => { throw matchAxiosErrorToRfcx(e) })
}

async function get (opts) {
  const url = `${apiHostName}streams/${opts.id}`
  const headers = {
    Authorization: `${opts.idToken}`,
    'Content-Type': 'application/json'
  }
  return axios.get(url, { headers })
    .catch(e => { throw matchAxiosErrorToRfcx(e) })
}

function parseIdFromHeaders (headers) {
  const regexResult = /\/streams\/(?<id>\w+)$/.exec(headers.location)
  if (regexResult) {
    return regexResult.groups.id
  }
  throw new Error(`Unable to parse location header: ${headers.location}`)
}

module.exports = {
  create,
  update,
  remove,
  query,
  get,
  parseIdFromHeaders
}
