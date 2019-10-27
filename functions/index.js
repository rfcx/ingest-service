const functions = require('firebase-functions');
const storage = require('./services/storage')

// HTTP endpoints
exports.api = functions.https.onRequest(require('./api'));

// Background triggers
exports.uploaded = functions.storage.bucket(storage.bucketName).object().onFinalize(require('./triggers/uploaded'))
exports.ingest = functions.runWith({ memory: '1GB' }).pubsub.schedule('every minute').onRun(require('./triggers/ingest'))
