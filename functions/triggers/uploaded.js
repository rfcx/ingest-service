const db = require(`../services/db/mongo`)

module.exports = async (object) => {
  const filePath = object.name
  if (!filePath.startsWith('uploaded/')) {
    return
  }

  const meta = extractMeta(filePath)

  await db.updateUploadStatus(meta.uploadId, db.status.UPLOADED)
}

// Extra stream id, upload id, and filename from the path
function extractMeta (path) {
  const pathParts = path.split('/')
  const streamId = pathParts[1]
  const filename = pathParts[2]
  const uploadId = filename.split('.')[0]
  return { streamId, filename, uploadId }
}
