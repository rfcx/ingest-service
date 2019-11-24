const { Storage } = require('@google-cloud/storage')
const storage = new Storage({
  keyFilename: process.env.GCS_SERVICE_ACCOUNT_KEY_FILE // See README for how to obtain a key
})

const bucketName = process.env.S3_UPLOAD_BUCKET

function getSignedUrl (filePath, contentType) {
  // Get a reference to the destination file in GCS
  const file = storage.bucket(bucketName).file(filePath)

  // Create a temporary upload URL
  const expiresAtMs = Date.now() + 300000 // Link expires in 5 minutes
  const config = {
    action: 'write',
    expires: expiresAtMs,
    contentType: contentType,
  }
  return file.getSignedUrl(config).then((data) => {
    const url = data[0];
    return url
  })
}

function download (remotePath, localPath) {
  return storage.bucket(bucketName).file(remotePath).download({ destination: localPath })
}

module.exports = { getSignedUrl, download }
