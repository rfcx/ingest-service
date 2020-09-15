const axios = require('axios')
const errors = require('../utils/errors')

const arbimonHost = process.env.ARBIMON_HOST

function userProject (idToken) {
  const url = `${arbimonHost}api/rfcx/user-project`
  const headers = {
    'Authorization': idToken,
    'Content-Type': 'application/json'
  }

  return axios.get(url, { headers })
    .then(response => {
      return response.data
    })
}

function createSite (opts, idToken) {
  const url = `${arbimonHost}api/rfcx/project/${opts.project_id}/sites/create`
  let data = {};
  ['name', 'external_id', 'lat', 'lon', 'alt'].forEach(attr => data[attr] = opts[attr])
  const headers = {
    'Authorization': idToken,
    'Content-Type': 'application/json'
  }

  return axios.post(url, data, { headers })
    .then(response => {
      return response.data
    })
}

function createRecording (opts, idToken) {
  const url = `${arbimonHost}api/rfcx/recordings/create`
  let data = {};
  ['project_id', 'site_external_id', 'uri', 'datetime', 'sample_rate', 'precision',
    'duration', 'samples', 'file_size', 'bit_rate', 'sample_encoding'].forEach(attr => data[attr] = opts[attr])
  const headers = {
    'Authorization': idToken,
    'Content-Type': 'application/json'
  }

  return axios.post(url, data, { headers })
    .then(response => {
      return response.data
    })
}

module.exports = {
  userProject,
  createSite,
  createRecording,
}
