const express = require('express')
const bodyParser = require('body-parser')
const Nuts = require('nuts-serve').Nuts
let app
if (process.env.NODE_ENV === 'development') {
  app = require('https-localhost')()
} else {
  app = express()
}

const nuts = Nuts({
  repository: process.env.GITHUB_REPO,
  token: process.env.GITHUB_TOKEN
})

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
      if (req.method === 'GET' && (/\/(uploads\/.+|health-check)/).test(req.url)) {
        return true
      }
      return false
    }
  }))
}

app.use(nuts.router)
app.use('/uploads', require('./routes/uploads'))
app.use('/streams', require('./routes/streams'))
app.use('/users', require('./routes/users'))
app.use('/deployments', require('./routes/deployments'))
app.use('/health-check', require('./routes/health-check'))

module.exports = app
