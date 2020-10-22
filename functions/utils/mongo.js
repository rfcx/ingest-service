const mongoose = require('mongoose')

const mongoUri = `mongodb://${process.env.MONGO_HOSTNAME}/${process.env.MONGO_DB}`

const db = mongoose.connection
db.on('connecting', function () {
  console.log('Connecting to MongoDB')
})
db.on('open', function () {
  console.log('Connected to MongoDB')
})
db.on('reconnected', function () {
  console.log('Reconnected to MongoDB')
})
db.on('disconnected', function () {
  console.error('Disconnected from MongoDB')
})
db.on('reconnectFailed', function () {
  console.error('Reconnection failed')
})

const connectWithRetry = () => {
  console.log('Establishing connection to MongoDB')
  mongoose.connect(mongoUri, {
    user: process.env.MONGO_USERNAME,
    pass: process.env.MONGO_PASSWORD,
    useNewUrlParser: true,
    useUnifiedTopology: false,
    autoReconnect: true,
    reconnectTries: 1000,
    reconnectInterval: 5000
  })
    .catch((e) => {
      console.log('Connection to MongoDB failed:', e && e.message ? e.message : '')
      setTimeout(connectWithRetry, 5000)
    })
}

connectWithRetry()

module.exports = db
