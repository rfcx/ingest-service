const express = require('express')
const { PROMETHEUS_ENABLED } = require('../services/prometheus')

const app = express()
if (PROMETHEUS_ENABLED) {
  app.use('/metrics', require('./metrics'))
}

// Catch errors
const { notFound, exceptionOccurred } = require('../middleware/error')
app.use(notFound) // Last route, catches all
app.use(exceptionOccurred) // Catches all errors (including 404)

module.exports = app
