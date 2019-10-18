const path = require('path')
const os = require('os')
const fs = require('fs')
const db = require('../services/db')
const storage = require('../services/storage')
const rfcx = require('../services/rfcxCheckin')

module.exports = async (object) => {
  const filePath = object.name
  if (!filePath.startsWith('uploaded/')) {
    return
  }

  const meta = extractMeta(filePath)
  const contentType = object.contentType
  const tempFilePath = path.join(os.tmpdir(), meta.filename);

  var error = undefined
  try {
    // Get the file from GCS
    await storage.download(filePath, tempFilePath)
    console.log('Downloaded locally to', tempFilePath)

    // Get the upload metadata
    const data = await db.getUpload(meta.uploadId)
    console.log('Original name', data.originalFilename)

    // Get the stream info
    const stream = await db.getStream(data.streamId)

    // Upload to RFCx
    await rfcx.checkin(tempFilePath, data.originalFilename, '%YYY%m%d-%H%M%S', data.streamId, stream.token)

  } catch (err) {
    error = err
  }

  const status = error ? db.status.FAILED : db.status.INGESTED
  const failureMessage = error ? error.message : null
  await db.updateUploadStatus(meta.uploadId, status, failureMessage)

  return fs.unlinkSync(tempFilePath)
}

// Extra stream id, upload id, and filename from the path
function extractMeta (path) {
  const pathParts = path.split('/')
  const streamId = pathParts[1]
  const filename = pathParts[2]
  const uploadId = filename.split('.')[0]
  return { streamId, filename, uploadId }
}