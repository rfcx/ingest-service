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
// Safety net: start() now self-heals (reconnect-with-backoff), but if it ever
// rejects fatally, exit so kubernetes restarts the pod instead of leaving it
// running-but-not-consuming (the silent-stalled-consumer bug). Previously this
// call was unguarded, so a RabbitMQ blip became an unhandledRejection that the
// process-handler logs but does NOT exit on — the pod looked healthy with 0
// consumers attached and the queue stalled.
ingestConsumer.start().catch((e) => {
  console.error('Ingest consumer failed to start; exiting for restart', e && e.message)
  process.exit(1)
})

// Ingest lane ROUTER (rfcx-local, 2026-07-14): consume the legacy upload queue,
// look up each upload's laneTier from Mongo, re-publish onto the matching lane
// queue for the weighted multi-lane consumer above. Only meaningful for the
// rabbitmq consumer type; disabled via INGEST_LANE_ROUTER=off. Self-healing;
// does NOT exit the pod on failure (the consumer is the liveness anchor).
if (consumerType === 'rabbitmq') {
  const { startRouter } = require('./services/consumer/router')
  startRouter().catch((e) => {
    console.error('Ingest lane router failed (continuing; consumer still drains legacy):', e && e.message)
  })
}
