const fs = require('fs')
const zlib = require('zlib')
const moment = require('moment')
const cryptoJS = require('crypto-js')
const querystring = require('querystring')
const axios = require('axios')
const FormData = require('form-data')
const { identify } = require('./audio')

const config = require('./rfcxConfig.json')
const apiHostName = config.apiHostName
const maxContentLength = config.maxUploadBytes

function getAudioFinalSha1 (filePath) {
  const fileContent = fs.readFileSync(filePath)
  const fileWordArray = cryptoJS.lib.WordArray.create(fileContent)
  const audioFinalSha1 = cryptoJS.SHA1(fileWordArray)
  return audioFinalSha1
}

async function generateJSON (filePath, timestampIso, fileType) {
  const timestampEpochMs = moment(timestampIso).valueOf()
  const sentAtEpochMs = moment().valueOf()

  const sha1 = getAudioFinalSha1(filePath)

  try {
    var result = await identify(filePath)
  } catch (error) {
    console.log(error)
    return
  }

  const audioElement = [sentAtEpochMs, timestampEpochMs, fileType, sha1, result.sampleRate, '1', fileType, 'vbr', '1', '16bit']
  console.log('dateEpoch: ' + timestampEpochMs)
  console.log('sentAtEpoch: ' + sentAtEpochMs)
  console.log('sha1: ' + sha1)
  console.log('audioSampleRate: ' + result.sampleRate)

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
  console.log('json:', jsonStr)
  // const jsonStr = '{"audio":"1566904446322*1548246896000*mp3*e3ecd8549ef9e973f20b23e342816fa284a8cbc9*12000*1*mp3*vbr*1*16bit","queued_at":1566904446322,"measured_at":1566904446322,"software":"guardian-cli*0.1.0|updater-cli*0.1.0","battery":"1566904446322*100*0","queued_checkins":"1","skipped_checkins":"0","stashed_checkins":"0"}'
  return new Promise((resolve, reject) => {
    zlib.gzip(jsonStr, (error, gzip) => {
      if (error) reject(error)
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
      console.log('request success')
      console.log(JSON.stringify(response.data))
    })
    .catch(function (error) {
      console.log('request error')
      console.log(error)
    })
}

async function checkin (filePath, originalFilename, timestampIso, guardianGuid, guardianToken) {
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

module.exports = { checkin }