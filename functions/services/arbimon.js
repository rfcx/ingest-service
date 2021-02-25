const axios = require('axios')
const errors = require('../utils/errors')
const { matchAxiosErrorToRfcx } = require('../utils/errors')

const arbimonHost = process.env.ARBIMON_HOST

function userProject (idToken) {
  const url = `${arbimonHost}api/ingest/user-project`
  const headers = {
    Authorization: idToken,
    'Content-Type': 'application/json'
  }

  return axios.get(url, { headers })
    .then(response => {
      return response.data
    })
    .catch(e => { throw matchAxiosErrorToRfcx(e) })
}

function createSite (opts, idToken) {
  const url = `${arbimonHost}api/ingest/project/${opts.project_id}/sites/create`
  const data = {};
  ['name', 'external_id', 'lat', 'lon', 'alt'].forEach(attr => data[attr] = opts[attr])
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

function syncSite (opts, idToken) {
  return userProject(idToken)
    .then((userProject) => {
      const data = {
        project_id: userProject.project_id,
        name: opts.name,
        external_id: opts.external_id,
        lat: opts.latitude,
        lon: opts.longitude,
        alt: opts.altitude || 0
      }
      return createSite(data, idToken)
    })
}

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
}

module.exports = {
  userProject,
  createSite,
  syncSite,
  createRecording
}
