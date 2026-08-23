require('dotenv').config()

require('./utils/process-handlers').installProcessHandlers('ingest-service-stuck-upload-reaper')

console.info('Stuck upload reaper: starting')
// utils/mongo connects at require time — only load it when the upload store is
// actually Mongo (mirrors main-api.js / main-upload-source-cleanup.js).
const { isPostgresUploads } = require('./utils/uploads-db')
if (!isPostgresUploads()) {
  require('./utils/mongo')
}
const { runStuckUploadReaper } = require('./services/rfcx/stuck-upload-reaper')

async function disconnectBackend () {
  try {
    if (isPostgresUploads()) {
      await require('./services/db/uploads-pg')._internal.closePool()
    } else {
      await require('mongoose').disconnect()
    }
  } catch (e) {
    console.error('Stuck upload reaper: disconnect failed', e && e.message ? e.message : e)
  }
}

runStuckUploadReaper()
  .then(async (counts) => {
    console.info('Stuck upload reaper: finished', JSON.stringify(counts))
    await disconnectBackend()
    // Exit non-zero ONLY on hard errors. A class-C report is a finding, not a
    // job failure: making it non-zero would turn every legitimate operator
    // notification into a CronJob "Failed" and train people to ignore it.
    process.exit(counts.error > 0 ? 1 : 0)
  })
  .catch(async (e) => {
    console.error('Stuck upload reaper: failed', e && e.stack ? e.stack : e)
    await disconnectBackend()
    process.exit(1)
  })
