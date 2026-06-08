require('../../utils/aws') // applies AWS.config.update() global creds/region
const fs = require('fs')
// Shared endpoint-aware S3 client factory. Routes through the in-cluster
// s3-proxy (s3-reader/s3-writer chain) when an endpoint is set; vanilla AWS
// otherwise. Centralized in @rfcx/s3-storage-client so endpoint/path-style
// wiring is identical across all RFCx services. NOTE: when no credential
// override is passed, the package omits creds and the client inherits the
// SDK-global creds set by utils/aws.js (AWS_ACCESS_KEY_ID etc.) -- same as
// the previous behavior.
const { createS3Client } = require('@rfcx/s3-storage-client')

const uploadBucket = process.env.UPLOAD_BUCKET

// Build a configured AWS.S3 client (endpoint-aware via the shared package).
// Optional per-bucket credentials override the global creds -- used when the
// upload bucket lives on a different provider (e.g. Cloudflare R2) than the
// segment-write bucket (e.g. B2 via the local s3-writer). signatureVersion v4
// is preserved via `extra`.
function buildS3Client ({ endpoint, forcePathStyle, accessKeyId, secretAccessKey, region }) {
  return createS3Client({
    endpoint,
    forcePathStyle: forcePathStyle === undefined ? undefined : (forcePathStyle === 'true' || forcePathStyle === true),
    accessKeyId,
    secretAccessKey,
    region,
    extra: { signatureVersion: 'v4' }
  })
}

// Default client. Used for everything unless overridden below.
// Reads AWS_S3_ENDPOINT + AWS_S3_FORCE_PATH_STYLE for endpoint config;
// credentials come from utils/aws.js (AWS_ACCESS_KEY_ID etc.).
const defaultClient = buildS3Client({
  endpoint: process.env.AWS_S3_ENDPOINT,
  forcePathStyle: process.env.AWS_S3_FORCE_PATH_STYLE
})

// Upload-bucket client (optional override). Used by:
//   - getSignedUrl()  — issues device-facing PUT URLs.
//   - download()      — tasks consumer fetches the audio blob.
//   - any deleteObject(uploadBucket, ...) call.
//
// When UPLOAD_S3_ENDPOINT is unset, falls back to defaultClient so
// behavior is bit-identical to the pre-override world. When set, the
// upload bucket is served by a separate provider (e.g. Cloudflare R2)
// and the device-facing signed URL hostname matches that endpoint.
//
// Independent credentials so an R2-only IAM key can be used here
// without exposing R2 creds to the segment-write path.
const uploadClient = process.env.UPLOAD_S3_ENDPOINT
  ? buildS3Client({
    endpoint: process.env.UPLOAD_S3_ENDPOINT,
    forcePathStyle: process.env.UPLOAD_S3_FORCE_PATH_STYLE,
    accessKeyId: process.env.UPLOAD_S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.UPLOAD_S3_SECRET_KEY,
    region: process.env.UPLOAD_S3_REGION_ID
  })
  : defaultClient

// Pick the right client for a given bucket. We key off the configured
// UPLOAD_BUCKET name; everything else uses the default.
function clientFor (bucket) {
  if (bucket === uploadBucket) { return uploadClient }
  return defaultClient
}

function getSignedUrl (filePath, contentType) {
  const params = {
    Bucket: uploadBucket,
    Key: filePath,
    Expires: 60 * 60 * 24, // 24 hours
    ContentType: contentType
  }
  return (new Promise((resolve, reject) => {
    uploadClient.getSignedUrl('putObject', params, (err, data) => {
      if (err) {
        reject(err)
      } else {
        resolve(data)
      }
    })
  }))
}

function download (remotePath, localPath) {
  return new Promise((resolve, reject) => {
    try {
      uploadClient.headObject({
        Bucket: uploadBucket,
        Key: remotePath
      }, (headErr, data) => {
        if (headErr) { reject(headErr) }
        const tempWriteStream = fs.createWriteStream(localPath)
        const tempReadStream = uploadClient.getObject({
          Bucket: uploadBucket,
          Key: remotePath
        })
          .createReadStream()

        tempReadStream.on('error', (errS3Res) => { reject(errS3Res) })

        tempReadStream
          .pipe(tempWriteStream)
          .on('error', (errWrite) => { reject(errWrite) })
          .on('close', () => {
            fs.stat(localPath, (statErr, fileStat) => {
              if (statErr) { reject(statErr) } else { resolve() }
            })
          })
      })
    } catch (err) {
      reject(new Error(err))
    }
  })
}

function upload (Bucket, remotePath, localPath) {
  const fileStream = fs.readFileSync(localPath)
  const opts = {
    Bucket,
    Key: remotePath,
    Body: fileStream
  }
  return clientFor(Bucket).putObject(opts).promise()
}

function createFromData (Bucket, remotePath, data) {
  const opts = {
    Bucket,
    Key: remotePath,
    Body: data
  }
  return clientFor(Bucket).putObject(opts).promise()
}

/**
 * Copies a file on S3.
 *
 * CopySource is "bucket/path"; the destination Bucket determines which
 * client we use. Cross-provider server-side copy (e.g. R2 -> AWS) is
 * not supported by AWS-SDK CopyObject — callers that need to move
 * objects between providers should download + upload explicitly.
 *
 * @param {*} CopySource Source path (including bucket)
 * @param {*} Bucket Destination bucket
 * @param {*} Key Destination path (excluding bucket)
 * @param {*} ContentType A standard MIME type describing the format of the object data.
 * @returns
 */
function copy (CopySource, Bucket, Key, ContentType) {
  const opts = { Bucket, CopySource, Key, ContentType }
  return clientFor(Bucket).copyObject(opts).promise()
}

function deleteObject (Bucket, Key) {
  const opts = { Bucket, Key }
  return clientFor(Bucket).deleteObject(opts).promise()
}

module.exports = {
  getSignedUrl,
  download,
  upload,
  createFromData,
  copy,
  deleteObject
}
