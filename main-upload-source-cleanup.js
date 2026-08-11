require('dotenv').config()

require('./utils/process-handlers').installProcessHandlers('ingest-service-upload-source-cleanup')

console.info('Upload source cleanup: starting')
// utils/mongo connects at require time — only load it when the upload store is
// actually Mongo (see main-api.js).
const { isPostgresUploads } = require('./utils/uploads-db')
if (!isPostgresUploads()) {
  require('./utils/mongo')
}
const { runUploadSourceCleanup } = require('./services/rfcx/upload-source-cleanup')

/**
 * Release whichever backend's connections are open. Mongo needs an explicit
 * disconnect; the pg pool is closed so the process can exit promptly rather
 * than waiting out idle timeouts. Both are best-effort: this runs immediately
 * before process.exit, so a teardown failure must not mask the run's result.
 */
async function disconnectBackend () {
  try {
    if (isPostgresUploads()) {
      await require('./services/db/uploads-pg')._internal.closePool()
    } else {
      await require('mongoose').disconnect()
    }
  } catch (e) {
    console.error('Upload source cleanup: disconnect failed', e && e.message ? e.message : e)
  }
}

runUploadSourceCleanup()
  .then(async (counts) => {
    console.info('Upload source cleanup: finished', JSON.stringify(counts))
    await disconnectBackend()
    process.exit(counts.error > 0 ? 1 : 0)
  })
  .catch(async (e) => {
    console.error('Upload source cleanup: failed', e && e.stack ? e.stack : e)
    await disconnectBackend()
    process.exit(1)
  })
