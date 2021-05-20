const express = require('express')
const bodyParser = require('body-parser')

const { PROMETHEUS_ENABLED } = require('./services/prometheus')
const { AUTOUPDATE_ENABLED } = require('./services/autoupdate')

const app = express()
app.use(bodyParser.urlencoded({ extended: true }))
app.use(bodyParser.json({ limit: '1mb' }))

if (process.env.PLATFORM === 'amazon') {
  app.use(require('./services/logging/amazon'))
}

app.use('/docs', require('./docs'))
app.use('/uploads', require('./routes/uploads'))
app.use('/projects', require('./routes/projects'))
app.use('/streams', require('./routes/streams'))
app.use('/deployments', require('./routes/deployments'))
app.use('/health-check', require('./routes/health-check'))

if (AUTOUPDATE_ENABLED) {
  app.use(require('./services/autoupdate').router)
}
if (PROMETHEUS_ENABLED) {
  app.use('/metrics', require('./routes/metrics'))
}

// Catch errors
const { notFound, exceptionOccurred } = require('./middleware/error')
app.use(notFound) // Last route, catches all
app.use(exceptionOccurred) // Catches all errors (including 404)

module.exports = app
