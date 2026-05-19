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
    .catch(e => {
      // Graceful degradation: if the project's upload-limit endpoint isn't
      // available (404 — the route is in biodiversity-api 'develop' but not
      // yet in 'master', so the deployed image may not have it; or the
      // project doesn't exist in biodiversity-api's DB at all), treat the
      // project as having NO upload limit configured. This matches the
      // semantics of `recordingMinutesLimit: null` further up the call
      // chain (assertProjectUploadWithinLimit in routes/uploads.js).
      //
      // The check exists to refuse uploads to view-only / over-quota
      // projects; missing endpoint is interpreted as 'no quota information
      // available, allow the upload'. The alternative (failing closed)
      // breaks all uploads when the dependency is out of sync, which is
      // both worse user experience and was the production behavior on
      // 2026-05-19 immediately after the Phase 3 ingest cutover landed.
      if (e && e.response && e.response.status === 404) {
        console.warn('[arbimon] upload-limit-summary endpoint returned 404 for project ' + projectId + '; treating as unlimited.')
        return { isLocked: false, recordingMinutesLimit: null, recordingMinutesCount: 0 }
      }
      throw matchAxiosErrorToRfcx(e)
    })
}

module.exports = {
  getProjectUploadLimitSummary
}
