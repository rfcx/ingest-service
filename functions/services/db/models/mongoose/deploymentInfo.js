const mongoose = require('mongoose');
const Decimal = mongoose.Schema.Types.Number;

const DeploymentInfoSchema = new mongoose.Schema({
  deploymentId: String,
  locationName: String,
  latitude: Number,
  longitude: Number,
  deployedAt: Date
});

const DeploymentInfo = mongoose.model('DeploymentInfo', DeploymentInfoSchema);

module.exports = {
  DeploymentInfoSchema,
  DeploymentInfo
}
