const path = require('path')
const os = require('os')
const db = require('../services/db')
const storage = require('../services/storage')
const rfcx = require('../services/rfcx')

module.exports = async (object) => {
  const filePath = object.name
  if (!filePath.startsWith('uploaded/')) {
    return
  }

  const meta = extractMeta(filePath)
  const contentType = object.contentType
  const tempFilePath = path.join(os.tmpdir(), meta.filename);

  // Get the file from GCS
  await storage.download(filePath, tempFilePath)
  console.log('Downloaded locally to', tempFilePath)

  // Get the upload metadata
  const data = await db.getUpload(meta.uploadId)
  console.log('Data about upload', data)

  // Upload to RFCx


  return fs.unlinkSync(tempFilePath);
}

// Extra stream id, upload id, and filename from the path
function extractMeta (path) {
  const pathParts = path.split('/')
  const streamId = pathParts[1]
  const filename = pathParts[2]
  const uploadId = filename.split('.')[0]
  return { streamId, filename, uploadId }
}