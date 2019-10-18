const fs = require('fs')
const zlib = require('zlib')
const moment = require('moment')
const cryptoJS = require('crypto-js')
const querystring = require('querystring')
const axios = require('axios')
const FormData = require('form-data')
const { identify } = require('./audio')

const apiHostName = require('./rfcxConfig.json').apiHostName

// TODO: get filename as a parameter (2019-06-01-14:05:30.opus, %YYY-%m-%d-%H:%M:%S) and do the logic to return datetime back
function getDateTime (fileName, timeStampFormat) {
  const stringOffsetYear = timeStampFormat.search('%Y')
  const stringOffsetMonth = timeStampFormat.search('%m')
  const stringOffsetDay = timeStampFormat.search('%d')
  const stringOffsetHour = timeStampFormat.search('%H')
  const stringOffsetMin = timeStampFormat.search('%M')
  const stringOffsetSec = timeStampFormat.search('%S')
  const year = fileName.substr(stringOffsetYear, 4)
  const month = fileName.substr(stringOffsetMonth, 2)
  const day = fileName.substr(stringOffsetDay, 2)
  const hour = fileName.substr(stringOffsetHour, 2)
  const min = fileName.substr(stringOffsetMin, 2)
  const sec = fileName.substr(stringOffsetSec, 2)

  // add milli sec
  const milliSeconds = 0

  // add timezone offset
  // TODO: check pref timestamp
  const timezoneOffset = '+0000'

  const dateTimeISO = year + '-' + month + '-' + day + 'T' + hour + ':' + min + ':' + sec + '.' + milliSeconds + timezoneOffset
  return dateTimeISO
}

function getAudioFinalSha1 (filePath) {
  const fileContent = fs.readFileSync(filePath)
  const fileWordArray = cryptoJS.lib.WordArray.create(fileContent)
  const audioFinalSha1 = cryptoJS.SHA1(fileWordArray)
  return audioFinalSha1
}

async function generateJSON (filePath, timestampIso) {
  const fileName = filePath.split('/').slice(-1)[0]
  const fileExtension = fileName.split('.').slice(-1)[0]

  const timestampEpoch = moment(timestampIso).unix() * 1000
  const sentAtEpoch = moment().unix()

  const sha1 = getAudioFinalSha1(filePath)

  try {
    var result = await identify(filePath)
  } catch (error) {
    console.log(error)
    return
  }

  const audioElement = [sentAtEpoch, timestampEpoch, fileExtension, sha1, result.sampleRate, '1', fileExtension, 'vbr', '1', '16bit']
  console.log('dateEpoch: ' + timestampEpoch)
  console.log('sentAtEpoch: ' + sentAtEpoch)
  console.log('sha1: ' + sha1)
  console.log('audioSampleRate: ' + result.sampleRate)

  // TODO: add LAT_LNG_JSON
  const checkInJson = {
    audio: audioElement.join('*'),
    queued_at: sentAtEpoch,
    measured_at: sentAtEpoch,
    software: 'ingest-service*0.0.1|ingest-service*0.0.1',
    battery: sentAtEpoch + '*100*0',
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

  console.log(guid)

  const headers = Object.assign(data.getHeaders(), {
    'x-auth-token': guardianToken,
    'x-auth-user': 'guardian/' + guid
  })

  console.log(headers)

  return axios.post(url, data, { headers })
    .then(function (response) {
      console.log('request success')
      console.log(JSON.stringify(response.data))
    })
    .catch(function (error) {
      console.log('request error')
      console.log(error)
    })
}

async function checkin (filePath, originalFilename, timestampFormat, guardianGuid, guardianToken) {
  // Meta
  const timestampIso = getDateTime(originalFilename, timestampFormat)
  const json = await generateJSON(filePath, timestampIso)
  const gzJson = await getGZippedJSON(json)

  // Audio
  const gzFile = fs.createReadStream(filePath).pipe(zlib.createGzip())
  const gzFilename = originalFilename + '.gz'

  return request(gzJson, gzFile, gzFilename, guardianGuid, guardianToken)
}

module.exports = { checkin }