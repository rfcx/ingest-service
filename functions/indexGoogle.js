const functions = require('firebase-functions')

// TODO Firebase should be able to autoload the config
require('dotenv').config()
const bucketName = process.env.UPLOAD_BUCKET

// HTTP endpoints
exports.api = functions.https.onRequest(require('./api'))

// Background triggers
exports.uploaded = functions.storage.bucket(bucketName).object().onFinalize(require('./triggers/uploaded'))

const ingest = require('./triggers/ingest')
const options = { memory: '1GB', timeoutSeconds: 180 }
const delayed = require('./utils/delay')
exports.ingest = functions.runWith(options).pubsub.schedule('* * * * *').onRun(ingest)
exports.ingest20 = functions.runWith(options).pubsub.schedule('* * * * *').onRun(delayed(ingest, 20000))
exports.ingest40 = functions.runWith(options).pubsub.schedule('* * * * *').onRun(delayed(ingest, 40000))
