const axios = require('axios')
const fs = require('fs')
const qs = require('querystring')
const moment = require('moment')
const sha1File = require('sha1-file')
const config = require('./rfcxConfig.json')
const { identify } = require('./audio')

const apiHostName = config.apiHostName
const accessToken = config.tempAccessToken
const targetBucketName = config.ingestManualBucketName

const aws = require('../utils/aws')
const s3Client = new aws.S3()


async function postAudio (guardianGuid, measuredAt, sha1Checksum, sampleCount, filename, numberOfBytes) {
  const url = apiHostName + 'v1/guardians/' + guardianGuid + '/audio'

  const data = { measured_at: measuredAt, sha1_checksum: sha1Checksum, size: numberOfBytes, capture_sample_count: sampleCount, format_id: 3, original_filename: filename }
  const headers = {
    'Authorization': 'Bearer ' + accessToken,
    'Content-Type': 'application/x-www-form-urlencoded'
  }

  return axios.post(url, qs.stringify(data), { headers })
    .then(response => {
      console.log('request success')
      console.log(response.data)
    }).catch(err => {
      console.log(err)
    })
}

async function putFile (localPath, remotePath) {
  const fileStream = fs.readFileSync(localPath)
  const object = { Bucket: targetBucketName, Key: remotePath, Body: fileStream };
  await s3Client.putObject(object).promise()
  console.log("Successfully uploaded data to " + targetBucketName + "/" + remotePath)
}

async function ingest (filePath, originalFilename, timestampIso, guardianGuid, guardianToken) {

  // Get sha1, sample count, size
  const sha1 = sha1File(filePath)
  const meta = await identify(filePath)

  // Put to S3 target bucket
  const timestamp = moment.utc(timestampIso)
  const originalExtension = originalFilename.split('.').pop()
  const remoteFilename = guardianGuid + '-' + timestamp.format('YYYY-MM-DD[T]HH-mm-ss') + '.' + originalExtension
  const remotePath = 'audio/' + timestamp.format('YYYY/MM/DD') + '/' + guardianGuid + '/' + remoteFilename
  await putFile(filePath, remotePath)

  // Call post audio endpoint
  await postAudio(guardianGuid, timestampIso, sha1, meta.sampleCount, originalFilename)
}

module.exports = { ingest }