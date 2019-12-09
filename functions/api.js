const express = require('express')
const bodyParser = require("body-parser")
const app = express()

app.use(bodyParser.urlencoded({ extended: true }))
app.use(bodyParser.json({ limit: '1mb' }));
if (process.env.PLATFORM === 'amazon') {
  const winston = require('winston')
  const expressWinston = require('express-winston')
  app.use(expressWinston.logger({
    transports: [
      new winston.transports.Console()
    ],
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.json()
    ),
    meta: true,
    msg: "HTTP {{req.method}} {{req.url}} | {{res.statusCode}} {{res.responseTime}}ms",
    expressFormat: true,
    colorize: true,
    ignoreRoute: function (req, res) { return false; }
  }));
}

app.use('/uploads', require('./routes/uploads'))
app.use('/streams', require('./routes/streams'))

module.exports = app
