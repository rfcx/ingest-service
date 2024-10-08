const mongoose = require('mongoose')

const mongoUri = `mongodb+srv://${process.env.MONGO_USERNAME}:${process.env.MONGO_PASSWORD}@${process.env.MONGO_HOSTNAME}/${process.env.MONGO_DB}?retryWrites=true&w=majority`

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
