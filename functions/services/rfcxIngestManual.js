const axios = require('axios')
const qs = require('querystring')
const moment = require('moment')
const sha1File = require('sha1-file')
const config = require('./rfcxConfig.json')

const apiHostName = config.apiHostName
const accessToken = config.tempAccessToken
const targetBucketName = config.ingestManualBucketName


async function postAudio (guardianGuid, measuredAt, sha1Checksum, sampleCount, size) {
  const url = apiHostName + 'v1/guardians/' + guardianGuid + '/audio'

  const data = { measured_at: measuredAt, sha1_checksum: sha1Checksum, size: size, capture_sample_count: sampleCount, format_id: 3 }
  const headers = {
    'Authorization': 'Bearer ' + accessToken,
    'Content-Type': 'application/x-www-form-urlencoded'
  }

  return axios.post(url, qs.stringify(data), { headers })
    .then(function (response) {
      console.log('request success')
      console.log(response.data)
    })
}

async function ingest (filePath, originalFilename, timestampIso, guardianGuid, guardianToken) {
  // Get sha1, sample count, size

  // Put to S3 target bucket
  const timestamp = moment(timestampIso)
  const remotePath = 'audio/' + timestamp.year + '/' + timestamp.month + '/' + timestamp.day + '/'
    + guardianGuid + '/' + guardianGuid + '-' + timestamp.format('')
  await putFile(filePath, remotePath)

  // Call post audio endpoint
  await postAudio(guardianGuid, timestampIso, sha1, sampleCount, size)
}

module.exports = { ingest }