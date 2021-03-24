const AWS = require('../../utils/aws')
const fs = require('fs')

const uploadBucket = process.env.UPLOAD_BUCKET

const s3Client = new AWS.S3({
  signatureVersion: 'v4'
})

function getSignedUrl (filePath, contentType) {
  const params = {
    Bucket: uploadBucket,
    Key: filePath,
    Expires: 60 * 60 * 24, // 24 hours
    ContentType: contentType
  }
  return (new Promise((resolve, reject) => {
    s3Client.getSignedUrl('putObject', params, (err, data) => {
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
      s3Client.headObject({
        Bucket: uploadBucket,
        Key: remotePath
      }, (headErr, data) => {
        if (headErr) { reject(headErr) }
        const tempWriteStream = fs.createWriteStream(localPath)
        const tempReadStream = s3Client.getObject({
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
  return s3Client.putObject(opts).promise()
}

function copyObject (desination, source) {
  // { Bucket: Bucket, prefix: prefix }
  const Bucket = desination.Bucket
  const opts = {
    Bucket,
    CopySource: '/' + source.Bucket + '/' + source.prefix,
    Key: desination.prefix
  }
  return s3Client.copyObject(opts).promise()
}

function deleteObject (Bucket, Key) {
  const opts = { Bucket, Key }
  return s3Client.deleteObject(opts).promise()
}

module.exports = {
  getSignedUrl,
  download,
  upload,
  copyObject,
  deleteObject
}
