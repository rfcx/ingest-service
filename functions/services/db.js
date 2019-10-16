const firebase = require('./firebase')
const db = firebase.firestore()
const FieldValue = require('firebase-admin').firestore.FieldValue;

const uploadCollection = 'uploads'
const status = { WAITING: 0, UPLOADED: 10, INGESTED: 20, FAILED: 30 }
const statusNumbers = Object.values(status)

function generateUpload (streamId, userId, originalFilename, fileType) {
  let ref = db.collection(uploadCollection).doc();
  let path = 'uploaded/' + streamId + '/' + ref.id + '.' + fileType
  return ref.set({
    streamId: streamId,
    userId: userId,
    status: status.WAITING,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    originalFilename: originalFilename,
    path: path
  }).then(() => {
    return { id: ref.id, path: path }
  })
}

function getUpload (id) {
  return db.collection(uploadCollection).doc(id).get().then(snapshot => {
    return snapshot.data()
  })
}

function updateUploadStatus (id, statusNumber, failureMessage = null) {
  if (!statusNumbers.includes(statusNumber)) {
    return Promise.reject('Invalid status')
  }
  var updates = {
    status: statusNumber,
    updatedAt: FieldValue.serverTimestamp()
  }
  if (failureMessage != null) {
    updates['failureMessage'] = failureMessage
  }
  return db.collection(uploadCollection).doc(id).update(updates)
}

module.exports = { generateUpload, getUpload, updateUploadStatus, status }
