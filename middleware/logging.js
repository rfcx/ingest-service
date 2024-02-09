const winston = require('winston')
const expressWinston = require('express-winston')

module.exports = expressWinston.logger({
  transports: [
    new winston.transports.Console()
  ],
  format: winston.format.combine(
    winston.format.simple()
  ),
  meta: false,
  msg: function (req, res) {
    const body = Array.isArray(req.body) ? req.body : { ...req.body }
    const userEmail = (req.rfcx && req.rfcx.auth_token_info && req.rfcx.auth_token_info.email) ? req.rfcx.auth_token_info.email : 'none'
    return `${req.method} ${res.statusCode} ${req.url} Response Time: ${res.responseTime} Authorization: ${req.headers.authorization} Email: ${userEmail} Body: ${JSON.stringify(body)}`
  },
  expressFormat: false,
  statusLevels: true
})
