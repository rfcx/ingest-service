const path = require('path')
const os = require('os')
const fs = require('fs')

const platform = process.env.PLATFORM || 'google';
const db = require(`../services/db/${platform}`)
const storage = require(`../services/storage/${platform}`);
const rfcx = require('../services/rfcx/ingest')(process.env.INGEST_METHOD)

module.exports = async (context) => {
  const startTime = Date.now()

  // Check if there is anything to ingest from the db
  var upload = undefined
  try {
    upload = await db.lockUploadForIngest()
  } catch (err) {
    console.log(err)
    return
  }
  logPerf(`Found id ${upload.id} original filename ${upload.originalFilename}`, startTime)

  const tempFilePath = path.join(os.tmpdir(), upload.id)

  var error = undefined
  try {
    // Get the file from GCS
    await storage.download(upload.path, tempFilePath)
    logPerf('Downloaded', startTime)

    // Get the stream info
    const stream = await db.getStream(upload.streamId)
    logPerf('Got stream', startTime)

    // Upload to RFCx
    await rfcx.ingest(tempFilePath, upload.originalFilename, upload.timestamp, upload.streamId, stream.token, stream.idToken)
    logPerf('Checked in', startTime)
  } catch (err) {
    error = err
  }

  const status = error ? db.status.FAILED : db.status.INGESTED
  const failureMessage = error ? error.message : null
  await db.updateUploadStatus(upload.id, status, failureMessage)

  return fs.unlinkSync(tempFilePath)
}

function logPerf (tag, startTime) {
  console.log(`${tag} time ${((Date.now() - startTime) / 1000).toFixed(3)} s`)
  // const used = process.memoryUsage();
  // for (let key in used) {
  //   console.log(`${tag} ${key} ${Math.round(used[key] / 1024 / 1024 * 100) / 100} MB`);
  // }
}
