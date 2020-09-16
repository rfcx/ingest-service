const express = require('express')
const bodyParser = require("body-parser")
const Nuts = require('nuts-serve').Nuts
let app;
if (process.env.NODE_ENV === 'development') {
  app = require("https-localhost")()
}
else {
  app = express()
}

const nuts = Nuts({
  repository: process.env.GITHUB_REPO,
  token: process.env.GITHUB_TOKEN,
})

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
    meta: false,
    msg: 'HTTP {{req.method}} {{req.url}} | {{res.statusCode}} {{res.responseTime}}ms',
    expressFormat: true,
    colorize: true,
    ignoreRoute: function (req, res) { return false; }
  }));
}

app.use(nuts.router);
app.use('/uploads', require('./routes/uploads'))
app.use('/streams', require('./routes/streams'))
app.use('/users', require('./routes/users'))

module.exports = app
