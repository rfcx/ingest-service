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
  const winston = require('winston')
  const expressWinston = require('express-winston')
  app.use(expressWinston.logger({
    transports: [
      new winston.transports.Console()
    ],
    format: winston.format.combine(
      winston.format.json()
    ),
    meta: true,
    requestWhitelist: ['headers', 'body'],
    headerBlacklist: [
      'host', 'x-request-id', 'x-real-ip', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-port', ' x-forwarded-proto',
      'x-original-uri', 'x-scheme', 'x-original-forwarded-for', 'content-length', 'accept', 'connection', 'origin', 'sec-fetch-mode',
      'sec-fetch-site', 'referer', 'accept-encoding', 'accept-language', 'user-agent'],
    expressFormat: true,
    ignoreRoute: function (req, res) {
      if (req.method === 'GET' && (/\/(uploads\/.+|health-check|metrics)/).test(req.url)) {
        return true
      }
      return false
    }
  }))
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
