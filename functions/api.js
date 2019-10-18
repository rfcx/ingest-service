const express = require('express')
const bodyParser = require("body-parser")
const app = express()

app.use(bodyParser.urlencoded({ extended: true }))

app.use('/uploads', require('./routes/uploads'))
app.use('/streams', require('./routes/streams'))

module.exports = app
