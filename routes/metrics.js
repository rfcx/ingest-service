const router = require('express').Router()
const { PROMETHEUS_ENABLED, register } = require('../services/prometheus')

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
  }
})

module.exports = router
