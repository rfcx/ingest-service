const axios = require('axios')
const errors = require('../../utils/error-messages')
const { matchAxiosErrorToRfcx } = require('../../utils/errors')

const apiHostName = process.env.API_HOST

function combineRequestPayload (opts) {
  return {
    ...opts.name !== undefined && { name: opts.name },
    ...opts.latitude !== undefined && { latitude: opts.latitude },
    ...opts.longitude !== undefined && { longitude: opts.longitude },
    ...opts.altitude !== undefined && { altitude: opts.altitude },
    ...opts.description !== undefined && { description: opts.description },
    ...opts.is_public !== undefined && { is_public: opts.is_public }
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

async function query (idToken, opts) {
  const url = `${apiHostName}streams`
  const params = {
    ...opts.is_public !== undefined && { is_public: opts.is_public },
    ...opts.is_deleted !== undefined && { is_deleted: opts.is_deleted },
    ...opts.created_by !== undefined && { created_by: opts.created_by },
    ...opts.start !== undefined && { start: opts.start },
    ...opts.end !== undefined && { end: opts.end },
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
  throw new Error(`Unable to parse location header: ${response.headers.location}`)
}

module.exports = {
  create,
  update,
  remove,
  query,
  get,
  parseIdFromHeaders
}
