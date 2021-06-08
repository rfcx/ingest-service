const axios = require('axios')
const fs = require('fs')
const moment = require('moment')
const sha1File = require('sha1-file')
const { identify } = require('../../audio')
const mimeUtil = require('../../../utils/mime')

const apiHostName = process.env.API_HOST
const targetBucketName = process.env.S3_INGEST_MANUAL_BUCKET

const aws = require('../../../utils/aws')
const s3Client = new aws.S3()

async function postAudio (guardianGuid, measuredAt, sha1Checksum, sampleCount, filename, numberOfBytes, idToken, meta) {
  const url = apiHostName + 'v1/guardians/' + guardianGuid + '/audio/withmeta'

  const data = {
    measured_at: measuredAt,
    sha1_checksum: sha1Checksum,
    size: numberOfBytes,
    capture_sample_count: sampleCount,
    codec: meta.format,
    mime: mimeUtil.mimeTypeFromAudioCodec(meta.format),
    file_extension: filename.split('.').pop(),
    sample_rate: meta.sampleRate,
    bit_rate: meta.bitRate,
    is_vbr: true,
    channel_count: meta.channelCount
  }
  const headers = {
    Authorization: `Bearer ${idToken.replace('Bearer ', '')}`,
    'Content-Type': 'application/json'
  }

  try {
    await axios.post(url, data, { headers })
  } catch (err) {
    console.log(JSON.stringify(err.response.data))
    if (err.response && err.response.data && err.response.data.msg) {
      if (err.response.data.msg === 'Failed to create audio: SequelizeUniqueConstraintError: Validation error') {
        throw new Error('Duplicate file. Matching sha1 signature already ingested.')
      } else {
        throw new Error(err.response.data.msg)
      }
    } else {
      throw err
    }
  }
}

async function putFile (localPath, remotePath) {
  const fileStream = fs.readFileSync(localPath)
  const object = { Bucket: targetBucketName, Key: remotePath, Body: fileStream }
  await s3Client.putObject(object).promise()
  console.log('Successfully uploaded data to ' + targetBucketName + '/' + remotePath)
}

async function ingest (filePath, originalFilename, timestampIso, guardianGuid, guardianToken, idToken) {
  // TODO: get idToken for server app from Auth0 - don't use client's token
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
  await postAudio(guardianGuid, timestampIso, sha1, meta.sampleCount, originalFilename, 0, idToken, meta)
}

module.exports = { ingest }
