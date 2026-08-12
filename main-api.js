if (process.env.NODE_ENV === 'production') {
  console.info('Starting newrelic')
  require('newrelic')
}
require('dotenv').config()

require('./utils/process-handlers').installProcessHandlers('ingest-service-api')

console.info('API: starting')
// utils/mongo CONNECTS at require time, so it must not be loaded when the
// upload store is PostgreSQL — otherwise the process keeps a live Mongo
// connection and a soak/cutover could not prove Mongo is unused.
if (!require('./utils/uploads-db').isPostgresUploads()) {
  require('./utils/mongo')
}
const api = require('./routes')

const port = process.env.PORT || 3030
api.listen(port, () => {
  console.info(`App is listening on port ${port}`)
})
