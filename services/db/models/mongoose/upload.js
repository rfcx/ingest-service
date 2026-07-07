const mongoose = require('mongoose')
require('mongoose-long')(mongoose)

const UploadSchema = new mongoose.Schema({
  streamId: String,
  userId: String,
  status: { type: Number, index: true },
  createdAt: { type: Date, default: Date.now, expires: '14d' }, // expires in 14 days
  updatedAt: { type: Date, default: Date.now },
  timestamp: Date,
  projectId: String,
  duration: Number,
  originalFilename: String,
  failureMessage: String,
  sampleRate: Number,
  targetBitrate: Number,
  checksum: String,
  uploadSource: {
    targetId: String,
    targetVersion: Number,
    provider: String,
    bucket: String,
    key: String,
    endpoint: String,
    region: String,
    forcePathStyle: Boolean
  },
  uploadSourceDeletedAt: Date,
  uploadSourceCleanupMessage: String,
  ingestionResult: {
    streamSourceFileId: String,
    streamId: String,
    projectId: String,
    siteId: String,
    arbimonProjectId: String,
    arbimonSiteId: String,
    ingestedAt: Date,
    segments: [{
      id: String,
      start: Date,
      end: Date,
      path: String
    }]
  }
})

const Upload = mongoose.model('StreamUpload', UploadSchema)

module.exports = {
  UploadSchema,
  Upload
}
