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
  // rfcx-local lane tier (2026-07-14): which ingest lane group this upload's
  // work is routed to by the lane router. One of express|priority|standard;
  // defaults to standard. The criteria that CHOOSE the tier live in the upload
  // registration endpoint (routes/uploads.js); this field is the persisted
  // decision the router reads.
  laneTier: { type: String, default: 'standard' },
  uploadSource: {
    targetId: String,
    targetVersion: Number,
    provider: String,
    bucket: String,
    key: String,
    endpoint: String,
    region: String,
    forcePathStyle: Boolean,
    secretRef: String
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
