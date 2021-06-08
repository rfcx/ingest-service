const winston = require('winston')
const expressWinston = require('express-winston')

module.exports = expressWinston.logger({
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
})
