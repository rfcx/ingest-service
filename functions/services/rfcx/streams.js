const axios = require('axios')
const errors = require('../../utils/errors')

const apiHostName = process.env.API_HOST

async function createStream (opts) {

  const url = `${apiHostName}v2/streams`;
  const data = {
    guid: opts.streamId,
    name: opts.name,
    visibility: opts.visibility
  }
  if (opts.site) {
    data.site = opts.site;
  }

  const headers = {
    'Authorization': opts.idToken,
    'Content-Type': 'application/json'
  }

  return axios.post(url, data, { headers })
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
  deleteStream,
  getUserStreams,
}
