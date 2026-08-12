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
      // Graceful degradation: the upload-limit / quota check is BEST-EFFORT.
      // It exists to refuse uploads to view-only / over-quota projects; if
      // the quota can't be determined we treat the project as having NO
      // upload limit configured (recordingMinutesLimit: null, matching
      // assertProjectUploadWithinLimit in routes/uploads.js) and ALLOW the
      // upload. Failing CLOSED here breaks otherwise-valid uploads whenever
      // the quota dependency is unhealthy — which was the production
      // behaviour on 2026-05-19 right after the Phase 3 ingest cutover.
      //
      // Two fail-open classes:
      //   404  — the biodiversity-api route isn't deployed, or the project
      //          doesn't exist in its DB.
      //   5xx  — the quota chain is unhealthy. In particular the summary
      //          proxies to the LEGACY arbimon2 `/project/:slug/tiering-usage`
      //          endpoint, whose session layer resolves the caller by email;
      //          a caller without an email claim (e.g. a machine/system
      //          token) makes that legacy hop 500. That legacy dependency is
      //          being retired (mysql2pg #40) — until then, a 5xx from the
      //          quota check must NOT block a valid upload. Real end-user
      //          tokens carry an email and enforce quota normally; this only
      //          fails open when the quota service itself can't answer.
      const status = e && e.response && e.response.status
      if (status === 404 || (typeof status === 'number' && status >= 500)) {
        console.warn('[arbimon] upload-limit-summary returned ' + status + ' for project ' + projectId + '; treating as unlimited (fail-open).')
        return { isLocked: false, recordingMinutesLimit: null, recordingMinutesCount: 0 }
      }
      throw matchAxiosErrorToRfcx(e)
    })
}

module.exports = {
  getProjectUploadLimitSummary
}
