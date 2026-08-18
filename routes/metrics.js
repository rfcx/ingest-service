const router = require('express').Router()
const { PROMETHEUS_ENABLED, register } = require('../services/prometheus')

/**
 * @swagger
 *
 * /metrics:
 *   get:
 *        summary: Prometheus metrics
 *        description: Prometheus scrape endpoint (501 when PROMETHEUS_ENABLED is not true)
 *        tags:
 *          - metrics
 *        responses:
 *          200:
 *            description: Metrics in Prometheus text exposition format
 *          500:
 *            description: Metric collection failed
 *          501:
 *            description: Metrics are disabled
 */
router.route('/').get((req, res) => {
  if (!PROMETHEUS_ENABLED) {
    res.sendStatus(501)
  } else {
    register.metrics()
      .then((metrics) => {
        res.setHeader('Content-Type', register.contentType)
        res.send(metrics)
        register.resetMetrics()
      })
      // DEFENCE IN DEPTH — this .catch() is load-bearing, do not remove it.
      //
      // `register.metrics()` gathers every registered metric under Promise.all.
      // Without a .catch() here, ANY rejection from ANY collector escapes as an
      // unhandledRejection, and utils/process-handlers.js deliberately
      // process.exit(1)s on that — so a metrics scrape kills a serving pod.
      // That is exactly the 2026-08-17/18 incident (~20 restarts per API
      // replica); see services/prometheus.js for the full chain.
      //
      // services/prometheus.js now wraps OUR two DB-backed gauges so they
      // cannot reject. This handler covers everything that wrapper cannot:
      // prom-client's own collectDefaultMetrics, and any future gauge added
      // without the wrapper. The two fixes are independent on purpose — the
      // wrapper keeps a DB blip from losing the whole scrape, this keeps a
      // scrape from ever losing the PROCESS.
      //
      // A failed scrape must be a 500 (Prometheus records the target as down
      // and moves on), never a process exit.
      .catch((err) => {
        console.error('[metrics] scrape failed (non-fatal):', err && err.message)
        // headersSent guard, same reasoning as middleware/error.js: this .catch()
        // also covers anything that throws INSIDE the .then() ABOVE — notably
        // resetMetrics() — by which point the body has already been sent.
        // Calling sendStatus() then throws ERR_HTTP_HEADERS_SENT synchronously
        // (verified), which would escape as an uncaughtException: the very class
        // of crash this file exists to prevent. The scrape itself already
        // succeeded in that case, so there is nothing to report to Prometheus.
        if (res.headersSent) { return }
        res.sendStatus(500)
      })
  }
})

module.exports = router
