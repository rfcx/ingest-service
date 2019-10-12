const fs = require('fs')
const zlib = require('zlib')
const moment = require('moment')
const cryptoJS = require('crypto-js')
const sox = require('sox')
const querystring = require('querystring')
const axios = require('axios')

const apiHostName = 'https://api.rfcx.org/'
const apiToken = 'j8kheb0k83fqrgsw2ur2g035pyd6cizoogsz2n51'
const guardianGuid = '5a279b776b3b'

// TODO: get filename as a parameter (2019-06-01-14:05:30.opus, %YYY-%m-%d-%H:%M:%S) and do the logic to return datetime back
function getDateTime (fileName, timeStampFormat) {
  console.log('filename: ' + fileName + ' timestamp format: ' + timeStampFormat)

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

  console.log(stringOffsetYear + '=' + year)
  console.log(stringOffsetMonth + '=' + month)
  console.log(stringOffsetDay + '=' + day)
  console.log(stringOffsetHour + '=' + hour)
  console.log(stringOffsetMin + '=' + min)
  console.log(stringOffsetSec + '=' + sec)

  // add milli sec
  const milliSeconds = 0

  // add timezone offset
  // TODO: check pref timestamp
  const timezoneOffset = '+0000'

  const dateTimeISO = year + '-' + month + '-' + day + 'T' + hour + ':' + min + ':' + sec + '.' + milliSeconds + timezoneOffset
  console.log('date iso: ' + dateTimeISO)
  return dateTimeISO
}

function getAudioFinalSha1 (filePath) {
  const fileContent = fs.readFileSync(filePath)
  const fileWordArray = cryptoJS.lib.WordArray.create(fileContent)
  const audioFinalSha1 = cryptoJS.SHA1(fileWordArray)
  return audioFinalSha1
}

/* Run sox to get the sample rate and duration
** results looks like:
** { format: 'wav', duration: 1.5, sampleCount: 66150, channelCount: 1, bitRate: 722944, sampleRate: 44100 }
*/
function identifyAudioFile (fileName) {
  return new Promise((resolve, reject) => {
    sox.identify(fileName, (err, result) => {
      if (err) {
        reject(err)
      } else {
        resolve(result)
      }
    })
  })
}

async function generateJSON (filePath, timestampIso) {
  const fileName = filePath.split('/').slice(-1)[0]
  const fileExtension = fileName.split('.').slice(-1)[0]

  const timestampEpoch = moment(timestampIso).unix() * 1000
  const sentAtEpoch = moment().unix()

  const sha1 = getAudioFinalSha1(filePath)

  try {
    var result = await identifyAudioFile(filePath)
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
      console.log('base64: ' + base64)
      console.log('hexdump: ' + hexdump)
      console.log('sed: ' + sed)
      resolve(sed)
    })
  })
}

function unzip (gZippedJson) {
  const a = querystring.parse('gzipped=' + gZippedJson)
  console.log(a)
  zlib.unzip(
    Buffer.from(querystring.parse('gzipped=' + gZippedJson).gzipped, 'base64'),
    function (zLibError, zLibBuffer) {
      if (!zLibError) {
        console.log(JSON.parse(zLibBuffer.toString()))
      } else {
        if (zLibError) {
          console.log(zLibError)
        }
      }
    })
}

const FormData = require('form-data')

axios.interceptors.request.use(request => {
  console.log('Starting Request', JSON.stringify(request))
  return request
})

function request (meta, audioStream) {
  const path = apiHostName + 'v1/guardians/' + guardianGuid + '/checkins'

  const data = new FormData()
  data.append('meta', meta)
  data.append('audio', audioStream)

  const headers = Object.assign(data.getHeaders(),
    {
      'Cache-Control': 'no-cache',
      'x-auth-token': apiToken,
      'x-auth-user': 'guardian/' + guardianGuid
    })
  console.log(JSON.stringify(headers))

  return axios.post(path, data, { headers })
    .then(function (response) {
      console.log('request success')
      console.log(JSON.stringify(response.data))
    })
    .catch(function (error) {
      console.log('request error')
      console.log(error)
    })
}

function gzipFile (filePath) {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath).pipe(zlib.createGzip())
    var buf = '';
    stream.on('data', d => { buf += d; })
      .on('end', () => { resolve(buf) })
      .on('error', err => reject(err))
  })
}

async function checkin (filePath, originalFilename, timestampFormat) {
  const timestampIso = getDateTime(originalFilename, timestampFormat)
  const json = await generateJSON(filePath, timestampIso)
  const gzJson = await getGZippedJSON(json)

  console.log('gzJson: ' + gzJson)

  //const gzFile = await gzipFile(filePath)
  const gzFile = fs.createReadStream(filePath) //.pipe(zlib.createGzip())
  await request(gzJson, gzFile)
}

module.exports = { checkin }