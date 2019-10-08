const { Storage } = require('@google-cloud/storage')
const storage = new Storage({
  keyFilename: "serviceAccountKeyStorageOnly.json"
})
const crypto = require("crypto")

/**
 * HTTP function that generates a signed URL
 * The signed URL can be used to upload files to Google Cloud Storage (GCS)
 *
 * @param {Object} req Cloud Function request context.
 * @param {Object} res Cloud Function response context.
 */
module.exports = (req, res) => {
  // TODO(developer) check that the user is authorized to upload

  const contentType = 'audio/wav'
  const uploadId = crypto.randomBytes(16).toString("hex")
  const filename = uploadId + '.wav'

  const bucket = 'rfcx-ingest-dev.appspot.com'
  const folder = 'uploads-test/'

  // Get a reference to the destination file in GCS
  const file = storage.bucket(bucket).file(folder + filename)

  // Create a temporary upload URL
  const expiresAtMs = Date.now() + 300000 // Link expires in 5 minutes
  const config = {
    action: 'write',
    expires: expiresAtMs,
    contentType: contentType,
  }

  file.getSignedUrl(config, (err, url) => {
    if (err) {
      console.error(err)
      res.status(500).end()
      return
    }
    res.json({ uploadId, url })
  })
}