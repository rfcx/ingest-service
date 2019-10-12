const firebase = require('./firebase')
const db = firebase.firestore()
const FieldValue = require('firebase-admin').firestore.FieldValue;

const uploadCollection = 'uploads'
const UPLOAD_STATUS = 0

function generateUpload (streamId, userId, originalFilename, fileType) {
  let ref = db.collection(uploadCollection).doc();
  let path = 'uploaded/' + streamId + '/' + ref.id + '.' + fileType
  return ref.set({
    streamId: streamId,
    userId: userId,
    status: UPLOAD_STATUS,
    timestamp: FieldValue.serverTimestamp(),
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

module.exports = { generateUpload, getUpload }

// let addDoc = db.collection('cities').add({
//   name: 'Tokyo',
//   country: 'Japan'
// }).then(ref => {
//   console.log('Added document with ID: ', ref.id);
// });