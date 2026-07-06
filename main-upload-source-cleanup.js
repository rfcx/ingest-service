require('dotenv').config()

require('./utils/process-handlers').installProcessHandlers('ingest-service-upload-source-cleanup')

console.info('Upload source cleanup: starting')
require('./utils/mongo')
const mongoose = require('mongoose')
const { runUploadSourceCleanup } = require('./services/rfcx/upload-source-cleanup')

runUploadSourceCleanup()
  .then(async (counts) => {
    console.info('Upload source cleanup: finished', JSON.stringify(counts))
    await mongoose.disconnect()
    process.exit(counts.error > 0 ? 1 : 0)
  })
  .catch(async (e) => {
    console.error('Upload source cleanup: failed', e && e.stack ? e.stack : e)
    await mongoose.disconnect().catch(() => {})
    process.exit(1)
  })
