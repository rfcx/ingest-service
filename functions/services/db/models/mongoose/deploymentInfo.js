const mongoose = require('mongoose');
const Decimal = mongoose.Schema.Types.Decimal128;

const DeploymentInfoSchema = new mongoose.Schema({
  deploymentId: String,
  locationName: String,
  latitude: Decimal,
  longitude: Decimal,
  deployedAt: Date
});

const DeploymentInfo = mongoose.model('DeploymentInfo', DeploymentInfoSchema);

module.exports = {
  DeploymentInfoSchema,
  DeploymentInfo
}
