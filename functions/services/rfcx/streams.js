const axios = require('axios')
const errors = require('../../utils/error-messages')

const apiHostName = process.env.API_HOST

function combineRequestPayload(opts) {
  return {
    ...opts.name !== undefined && { name: opts.name },
    ...opts.latitude !== undefined && { latitude: opts.latitude },
    ...opts.longitude !== undefined && { longitude: opts.longitude },
    ...opts.description !== undefined && { description: opts.description },
    ...opts.is_private !== undefined && { is_private: opts.is_private },
  }
}

async function createStream (opts) {

  const url = `${apiHostName}streams`;
  const data = combineRequestPayload(opts)

  const headers = {
    'Authorization': opts.idToken,
    'Content-Type': 'application/json'
  }

  return axios.post(url, data, { headers })
}

async function updateStream (opts) {

  const url = `${apiHostName}streams/${opts.streamId}`;
  const data = combineRequestPayload(opts)

  const headers = {
    'Authorization': opts.idToken,
    'Content-Type': 'application/json'
  }

  return axios.patch(url, data, { headers })
}

async function moveStreamToTrash (opts) {

  const url = `${apiHostName}v2/streams/${opts.streamId}/move-to-trash`;
  const headers = {
    'Authorization': opts.idToken,
    'Content-Type': 'application/json'
  }

  return axios.post(url, {}, { headers })
}

async function deleteStream (opts) {

  const url = `${apiHostName}v2/streams/${opts.streamId}`;
  const headers = {
    'Authorization': opts.idToken,
    'Content-Type': 'application/json'
  }

  return axios.delete(url, { headers })
}

async function query (idToken, opts) {

  const url = `${apiHostName}streams`
  const params = {
    ...opts.is_private !== undefined && { is_private: opts.is_private },
    ...opts.is_deleted !== undefined && { is_deleted: opts.is_deleted },
    ...opts.created_by !== undefined && { created_by: opts.created_by },
    ...opts.start !== undefined && { start: opts.start },
    ...opts.end !== undefined && { end: opts.end },
    ...opts.keyword !== undefined && { keyword: opts.keyword },
    ...opts.limit !== undefined && { limit: opts.limit },
    ...opts.offset !== undefined && { offset: opts.offset },
  }
  const headers = {
    'Authorization': `${idToken}`,
    'Content-Type': 'application/json'
  }

  return axios.get(url, { headers, params })
}

module.exports = {
  createStream,
  updateStream,
  moveStreamToTrash,
  deleteStream,
  query,
}
