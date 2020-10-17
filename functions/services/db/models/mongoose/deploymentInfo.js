const mongoose = require('mongoose');

const DeploymentInfoSchema = new mongoose.Schema({
  deploymentId: String,
  locationName: String,
  latitude: Number,
  longitude: Number,
  locationGroup: { groupName: String, groupColor: String },
  deployedAt: Date
});

const DeploymentInfo = mongoose.model('DeploymentInfo', DeploymentInfoSchema);

module.exports = {
  DeploymentInfoSchema,
  DeploymentInfo,
}
