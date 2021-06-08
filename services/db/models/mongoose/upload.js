const mongoose = require('mongoose')
require('mongoose-long')(mongoose)

const UploadSchema = new mongoose.Schema({
  streamId: String,
  userId: String,
  status: Number,
  createdAt: { type: Date, default: Date.now, expires: '30d' }, // expires in 30 days
  updatedAt: { type: Date, default: Date.now },
  timestamp: Date,
  originalFilename: String,
  failureMessage: String,
  sampleRate: Number,
  targetBitrate: Number,
  checksum: String
})

const Upload = mongoose.model('StreamUpload', UploadSchema)

module.exports = {
  UploadSchema,
  Upload
}
