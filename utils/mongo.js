const mongoose = require('mongoose')

// rfcx-local fork: support plain mongodb:// when MONGO_PROTOCOL=mongodb is set.
// Default (unset or 'mongodb+srv') is bit-identical to upstream: Atlas-style SRV+TLS URI.
// When MONGO_PROTOCOL=mongodb is set, build a plain mongodb:// URI including the port
// (Atlas does not use a port; local mongo does). MONGO_PORT defaults to 27017.
const protocol = process.env.MONGO_PROTOCOL || 'mongodb+srv'
const mongoUri = protocol === 'mongodb'
  ? `mongodb://${process.env.MONGO_USERNAME}:${process.env.MONGO_PASSWORD}@${process.env.MONGO_HOSTNAME}:${process.env.MONGO_PORT || 27017}/${process.env.MONGO_DB}?retryWrites=true&w=majority&authSource=${process.env.MONGO_AUTH_SOURCE || process.env.MONGO_DB}`
  : `mongodb+srv://${process.env.MONGO_USERNAME}:${process.env.MONGO_PASSWORD}@${process.env.MONGO_HOSTNAME}/${process.env.MONGO_DB}?retryWrites=true&w=majority`

const db = mongoose.connection
db.on('connecting', function () {
  console.info('Connecting to MongoDB')
})
db.on('open', function () {
  console.info('Connected to MongoDB')
})
db.on('reconnected', function () {
  console.info('Reconnected to MongoDB')
})
db.on('disconnected', function () {
  console.error('Disconnected from MongoDB')
})
db.on('reconnectFailed', function () {
  console.error('Reconnection failed')
})

const connectWithRetry = () => {
  console.info('Establishing connection to MongoDB')
  mongoose.set('strictQuery', false)
  mongoose.connect(mongoUri, {
    user: process.env.MONGO_USERNAME,
    pass: process.env.MONGO_PASSWORD
  })
    .catch((e) => {
      console.error('Connection to MongoDB failed:', e && e.message ? e.message : '')
      setTimeout(connectWithRetry, 10000)
    })
}

connectWithRetry()

module.exports = db
