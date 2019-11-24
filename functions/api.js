require('dotenv').config()

const express = require('express')
const bodyParser = require("body-parser")
const app = express()

app.use(bodyParser.urlencoded({ extended: true }))
app.use(bodyParser.json({ limit: '1mb' }));

app.use('/uploads', require('./routes/uploads'))
app.use('/streams', require('./routes/streams'))

if (process.env.PLATFORM === 'amazon') {
  const port = process.env.PORT || 3030;
  app.listen(port, function () {
    console.log(`App is listening on port ${port}`);
  });
}

module.exports = app
