require('dotenv').config()

require('./utils/process-handlers').installProcessHandlers('ingest-service-tasks')

console.info('Tasks: starting')
require('./utils/mongo')
const api = require('./routes/index-tasks')

const port = process.env.PORT || 3030
api.listen(port, () => {
  console.info(`App is listening on port ${port}`)
})

// Select ingest consumer implementation.
//   INGEST_CONSUMER_TYPE=amazon   (default; AWS SQS trigger, legacy)
//   INGEST_CONSUMER_TYPE=rabbitmq (rfcx-local; RabbitMQ trigger)
const consumerType = process.env.INGEST_CONSUMER_TYPE || 'amazon'
const ingestConsumer = require(`./services/consumer/${consumerType}`)
ingestConsumer.start()
