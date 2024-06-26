const express = require('express')
const bodyParser = require('body-parser')

const { PROMETHEUS_ENABLED } = require('../services/prometheus')
const { AUTOUPDATE_ENABLED } = require('../services/autoupdate')

const { verifyToken } = require('../middleware/authentication')

const app = express()
app.use(bodyParser.urlencoded({ extended: true }))
app.use(bodyParser.json({ limit: '1mb' }))
app.use(require('../middleware/cors'))
app.use(require('../middleware/logging'))

app.use('/docs', require('../docs'))
app.use('/uploads', verifyToken(), require('./uploads'))
app.use('/projects', verifyToken(), require('./projects'))
app.use('/streams', verifyToken(), require('./streams'))
app.use('/deployments', verifyToken(), require('./deployments'))
app.use('/health-check', require('./health-check'))

if (AUTOUPDATE_ENABLED) {
  app.use(require('../services/autoupdate').router)
}
if (PROMETHEUS_ENABLED) {
  app.use('/metrics', require('./metrics'))
}

// Catch errors
const { notFound, exceptionOccurred } = require('../middleware/error')
app.use(notFound) // Last route, catches all
app.use(exceptionOccurred) // Catches all errors (including 404)

module.exports = app
