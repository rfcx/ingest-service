const { Storage } = require('@google-cloud/storage')
const storage = new Storage({
  keyFilename: "serviceAccountKeyStorageOnly.json"
})

function getSignedUrl (filePath, contentType) {
  // Get a reference to the destination file in GCS
  const bucket = 'rfcx-ingest-dev.appspot.com' // TODO extract to env variables
  const file = storage.bucket(bucket).file(filePath)

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

module.exports = { getSignedUrl }