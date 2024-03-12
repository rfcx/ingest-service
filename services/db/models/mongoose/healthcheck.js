const mongoose = require('mongoose')

const HealthCheckSchema = new mongoose.Schema({
  event: String
})

const HealthCheck = mongoose.model('HealthCheck', HealthCheckSchema)

module.exports = {
  HealthCheckSchema,
  HealthCheck
}
