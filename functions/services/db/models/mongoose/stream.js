const mongoose = require('mongoose');
require('mongoose-long')(mongoose);
const Long = mongoose.Schema.Types.Long;

const StreamSchema = new mongoose.Schema({
  guid: String,
  name: String,
  token: String,
  site: String,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

const Stream = mongoose.model('Stream', StreamSchema);

module.exports = {
  StreamSchema,
  Stream
}
