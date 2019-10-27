const path = require('path')
const os = require('os')
const fs = require('fs')
const db = require('../services/db')
const storage = require('../services/storage')
const rfcx = require('../services/rfcxCheckin')

module.exports = async (context) => {
  console.log('Ingest: Triggered')

  // Check if there is anything to ingest from the db
  var upload = undefined
  try {
    upload = await db.lockUploadForIngest()
  } catch (err) {
    console.log('Ingest: ', err.message)
    return
  }

  console.log('Ingest: Found id', upload.id, 'Original filename', upload.originalFilename)

  const tempFilePath = path.join(os.tmpdir(), upload.id)

  var error = undefined
  try {
    // Get the file from GCS
    await storage.download(upload.path, tempFilePath)
    console.log('Ingest: Downloaded locally to', tempFilePath)

    // Get the stream info
    const stream = await db.getStream(upload.streamId)

    // Upload to RFCx
    await rfcx.checkin(tempFilePath, upload.originalFilename, upload.timestamp, upload.streamId, stream.token)

  } catch (err) {
    error = err
  }

  const status = error ? db.status.FAILED : db.status.INGESTED
  const failureMessage = error ? error.message : null
  await db.updateUploadStatus(upload.id, status, failureMessage)

  return fs.unlinkSync(tempFilePath)
}

