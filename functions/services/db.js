const firebase = require('./firebase')
const db = firebase.firestore()
const FieldValue = require('firebase-admin').firestore.FieldValue;

const uploadsCollection = 'uploads'
const status = { WAITING: 0, UPLOADED: 10, INGESTED: 20, FAILED: 30 }
const statusNumbers = Object.values(status)
const streamsCollection = 'streams'

function generateUpload (streamId, userId, originalFilename, fileType) {
  let ref = db.collection(uploadsCollection).doc()
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
  return db.collection(uploadsCollection).doc(id).get().then(snapshot => {
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
  return db.collection(uploadsCollection).doc(id).update(updates)
}

function createStream (name) {
  const ref = db.collection(streamsCollection).doc()
  return ref.set({
    name: name,
    token: '1234' // TODO: this is only here for legacy calls to checkin api
  }).then(() => {
    return { id: ref.id }
  })
}

function getStream (id) {
  return db.collection(streamsCollection).doc(id).get().then(snapshot => {
    return snapshot.data()
  })
}

module.exports = { generateUpload, getUpload, updateUploadStatus, status, createStream, getStream }
