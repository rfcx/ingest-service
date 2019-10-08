const express = require('express')
const app = express()

app.post('/uploads', require('./uploads'))

module.exports = app
