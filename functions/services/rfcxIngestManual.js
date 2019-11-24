const axios = require('axios')
const fs = require('fs')
const qs = require('querystring')
const moment = require('moment')
const sha1File = require('sha1-file')
const { identify } = require('./audio')

const apiHostName = process.env.API_HOST
const accessToken = process.env.TEMP_ACCESS_TOKEN
const targetBucketName = process.env.S3_INGEST_MANUAL_BUCKET

const aws = require('../utils/aws')
const s3Client = new aws.S3()


async function postAudio (guardianGuid, measuredAt, sha1Checksum, sampleCount, filename, numberOfBytes) {
  const url = apiHostName + 'v1/guardians/' + guardianGuid + '/audio'

  const data = { measured_at: measuredAt, sha1_checksum: sha1Checksum, size: numberOfBytes, capture_sample_count: sampleCount, format_id: 3 }
  const headers = {
    'Authorization': 'Bearer ' + accessToken,
    'Content-Type': 'application/x-www-form-urlencoded'
  }

  try {
    const response = await axios.post(url, qs.stringify(data), { headers })
  } catch (err) {
    console.log(JSON.stringify(err.response.data))
    if (err.response && err.response.data && err.response.data.msg) {
      if (err.response.data.msg == 'Failed to create audio: SequelizeUniqueConstraintError: Validation error') {
        throw { message: 'Duplicate file. Matching sha1 signature already ingested.' }
      } else {
        throw { message: err.response.data.msg }
      }
    } else {
      throw err
    }
  }
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
  await postAudio(guardianGuid, timestampIso, sha1, meta.sampleCount, originalFilename, 0)
}

module.exports = { ingest }
