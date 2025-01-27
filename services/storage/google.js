const { Storage } = require('@google-cloud/storage')
const storage = new Storage()

const uploadBucket = storage.bucket(process.env.UPLOAD_BUCKET)

function getSignedUrl (filePath, contentType) {
  // Get a reference to the destination file in GCS
  const file = uploadBucket.file(filePath)

  // Create a temporary upload URL
  const expiresAtMs = Date.now() + 300000 // Link expires in 5 minutes
  const config = {
    action: 'write',
    expires: expiresAtMs,
    contentType: contentType
  }
  return file.getSignedUrl(config).then((data) => {
    const url = data[0]
    return url
  })
}

function download (source, destination) {
  return uploadBucket.file(source).download({ destination })
}

function upload (bucket, destination, source) {
  return storage.bucket(bucket).upload(source, { destination })
}

function createFromData (Bucket, remotePath, data) {
  // TODO: implement this
}

function copyObject (desination, source) {
  return storage
    .bucket(source.Bucket)
    .file(source.prefix)
    .copy(storage.bucket(desination.Bucket).file(desination.prefix))
}

function deleteObject (bucket, path) {
  return storage.bucket(bucket).file(path).delete()
}

module.exports = {
  getSignedUrl,
  download,
  upload,
  createFromData,
  copyObject,
  deleteObject
}
