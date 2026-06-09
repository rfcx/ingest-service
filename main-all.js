if (process.env.NODE_ENV === 'production') {
  require('newrelic')
}
require('dotenv').config()

require('./utils/process-handlers').installProcessHandlers('ingest-service-all')

console.info('API and Tasks: starting')

const api = require('./routes')

async function main () {
  const port = process.env.PORT || 3030
  api.listen(port, () => {
    console.info(`App is listening on port ${port}`)
  })

  const ingestConsumer = require('./services/consumer/amazon')
  // Safety net: exit (so k8s restarts) rather than leaving the pod
  // running-but-not-consuming if the consumer fails to start.
  await ingestConsumer.start()
}

main().catch((e) => {
  console.error('ingest-service-all main() failed; exiting for restart', e && e.message)
  process.exit(1)
})
