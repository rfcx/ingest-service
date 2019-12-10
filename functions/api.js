const express = require('express')
const bodyParser = require("body-parser")
const app = express()

app.use(bodyParser.urlencoded({ extended: true }))
app.use(bodyParser.json({ limit: '1mb' }));

app.use('/uploads', require('./routes/uploads'))
app.use('/streams', require('./routes/streams'))
app.use('/users', require('./routes/users'))

module.exports = app
