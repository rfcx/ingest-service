const fs = require('fs')
const zlib = require('zlib')
const moment = require('moment')
const sha1File = require('sha1-file')
const axios = require('axios')
const FormData = require('form-data')
const { identify } = require('../../audio')

const apiHostName = process.env.API_HOST
const maxContentLength = process.env.MAX_UPLOAD_BYTES ? parseInt(process.env.MAX_UPLOAD_BYTES) : 209715200

async function generateJSON (filePath, timestampIso, fileType) {
  const timestampEpochMs = moment(timestampIso).valueOf()
  const sentAtEpochMs = moment().valueOf()

  const sha1 = sha1File(filePath)
  const meta = await identify(filePath)

  const audioElement = [sentAtEpochMs, timestampEpochMs, fileType, sha1, meta.sampleRate, '1', fileType, 'vbr', '1', '16bit']

  // TODO: add LAT_LNG_JSON
  const checkInJson = {
    audio: audioElement.join('*'),
    queued_at: sentAtEpochMs,
    measured_at: sentAtEpochMs,
    software: 'ingest-service*0.0.1|ingest-service*0.0.1',
    battery: sentAtEpochMs + '*100*0',
    queued_checkins: 1,
    skipped_checkins: 0,
    stashed_checkins: 0
  }
  return checkInJson
}

// gzip
function getGZippedJSON (json) {
  const jsonStr = JSON.stringify(json)
  return new Promise((resolve, reject) => {
    zlib.gzip(jsonStr, (error, gzip) => {
      if (error) { reject(error) }
      const base64 = Buffer.from(gzip, 'ascii').toString('base64')
      const hexdump = Buffer.from(base64).toString('hex')
      const hexArray = hexdump.match(/.{1,2}/g)
      const sed = '%' + hexArray.join('%')
      resolve(sed)
    })
  })
}

function request (meta, audioStream, audioFilename, guardianGuid, guardianToken) {
  const guid = guardianGuid.toLowerCase()
  const url = apiHostName + 'v1/guardians/' + guid + '/checkins'

  const data = new FormData()
  data.append('meta', meta)
  data.append('audio', audioStream, audioFilename)

  const headers = Object.assign(data.getHeaders(), {
    'x-auth-token': guardianToken,
    'x-auth-user': 'guardian/' + guid
  })

  return axios.post(url, data, { headers, maxContentLength })
    .then(function (response) {
      console.log(JSON.stringify(response.data))
    })
}

async function ingest (filePath, originalFilename, timestampIso, guardianGuid, guardianToken, idToken) {
  // Hack to upload wav files
  if (originalFilename.endsWith('.wav')) {
    originalFilename = originalFilename.substring(0, originalFilename.length - 3) + 'flac'
  }

  const fileType = originalFilename.split('.').pop()

  // Meta
  const json = await generateJSON(filePath, timestampIso, fileType)
  const gzJson = await getGZippedJSON(json)

  // Audio
  const gzFile = fs.createReadStream(filePath).pipe(zlib.createGzip())
  const gzFilename = originalFilename + '.gz'

  return request(gzJson, gzFile, gzFilename, guardianGuid, guardianToken)
}

module.exports = { ingest }
