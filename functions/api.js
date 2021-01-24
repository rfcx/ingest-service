const express = require('express')
const bodyParser = require('body-parser')
const { PROMETHEUS_ENABLED } = require('./services/prometheus')
const { AUTOUPDATE_ENABLED } = require('./services/autoupdate')
let app
if (process.env.NODE_ENV === 'development' && process.env.PLATFORM === 'google') {
  app = require('https-localhost')()
} else {
  app = express()
}

app.use(bodyParser.urlencoded({ extended: true }))
app.use(bodyParser.json({ limit: '1mb' }))

if (process.env.PLATFORM === 'amazon') {
  app.use(require('./services/logging/amazon'))
}

app.use('/docs', require('./docs'))
app.use('/uploads', require('./routes/uploads'))
app.use('/streams', require('./routes/streams'))
app.use('/users', require('./routes/users'))
app.use('/deployments', require('./routes/deployments'))
app.use('/health-check', require('./routes/health-check'))

if (AUTOUPDATE_ENABLED) {
  app.use(require('./services/autoupdate').router)
}
if (PROMETHEUS_ENABLED) {
  app.use('/metrics', require('./routes/metrics'))
}

module.exports = app
