const AWS = require('../../utils/aws');
const fs = require('fs');

const bucketName = process.env.UPLOAD_BUCKET

const s3Client = new AWS.S3({
  signatureVersion: 'v4',
  endpoint: new AWS.Endpoint(`${bucketName}.s3-accelerate.amazonaws.com`),
  useAccelerateEndpoint: true,
});

function getSignedUrl (filePath, contentType) {
  const params = {
    Bucket: bucketName,
    Key: filePath,
    Expires: 60 * 60 * 24, // 24 hours
    ContentType: contentType
  };
  return (new Promise((resolve, reject) => {
    s3Client.getSignedUrl('putObject', params, (err, data) => {
      if (err) {
        reject(err)
      } else {
        resolve(data)
      }
    });
  }));
}

function download (remotePath, localPath) {
  return new Promise((resolve, reject) => {
    try {
      s3Client.headObject({
        Bucket: process.env.UPLOAD_BUCKET,
        Key: remotePath
      }, (headErr, data) => {
        if (headErr) { reject(headErr); }
        let tempWriteStream = fs.createWriteStream(localPath);
        let tempReadStream  = s3Client.getObject({
          Bucket: process.env.UPLOAD_BUCKET,
          Key: remotePath
        })
        .createReadStream()

        tempReadStream.on('error', (errS3Res) => { reject(errS3Res) });

        tempReadStream
          .pipe(tempWriteStream)
          .on('error', (errWrite) => { reject(errWrite); })
          .on('close', () => {
            fs.stat(localPath, (statErr, fileStat) => {
              if (statErr) { reject(statErr) }
              else { resolve() }
            });
          });
      });
    }
    catch(err) {
      reject(new Error(err));
    }
  });
}

module.exports = {
  getSignedUrl,
  download,
}
