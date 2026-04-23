const axios = require('../../utils/axios')
const { matchAxiosErrorToRfcx } = require('../../utils/errors')

const arbimonHost = (process.env.ARBIMON_HOST || '').replace(/\/+$/, '')

function getProjectUploadLimitSummary (idToken, projectId) {
  const url = `${arbimonHost}/projects-core/${projectId}/upload-limit-summary`
  const headers = {
    Authorization: `${idToken}`,
    'Content-Type': 'application/json'
  }

  return axios.get(url, { headers })
    .then(response => response.data)
    .catch(e => { throw matchAxiosErrorToRfcx(e) })
}

module.exports = {
  getProjectUploadLimitSummary
}
