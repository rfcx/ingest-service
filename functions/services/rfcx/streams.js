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

async function getUserStreams (idToken, access) {

  const url = `${apiHostName}v2/streams`
  const headers = {
    'Authorization': `${idToken}`,
    'Content-Type': 'application/json'
  }
  let params = { }
  if (access) {
    params.access = access;
  }

  return axios.get(url, { headers, params })
    .then(response => {
      return response.data
    })
    .catch(err => {
      if (err.response && err.response.status === 401) {
        throw new Error(errors.UNAUTHORIZED)
      }
      throw err
    })

}

module.exports = {
  createStream,
  updateStream,
  moveStreamToTrash,
  deleteStream,
  getUserStreams,
}
