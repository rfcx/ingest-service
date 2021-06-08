const { PROMETHEUS_ENABLED, register } = require('../utils/prometheus')
if (!PROMETHEUS_ENABLED) {
  return
}
const router = require('express').Router()

router.route('/').get(async (req, res) => {
  res.setHeader('Content-Type', register.contentType)
  res.send(await register.metrics())
  register.resetMetrics()
})

module.exports = router
