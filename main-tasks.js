require('dotenv').config()

console.info('Tasks: starting')

const ingestConsumer = require('./services/consumer/amazon')
ingestConsumer.start()
