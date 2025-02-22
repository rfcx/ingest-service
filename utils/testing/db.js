const mongoose = require('mongoose')
const { MongoMemoryServer } = require('mongodb-memory-server')
const UploadModel = require('../../services/db/models/mongoose/upload').Upload
const DeploymentInfoModel = require('../../services/db/models/mongoose/deploymentInfo').DeploymentInfo

let mongoServer

async function connect () {
  if (!mongoServer) {
    mongoServer = await MongoMemoryServer.create()
  }
  const uri = await mongoServer.getUri()
  mongoose.set('strictQuery', false)
  await mongoose.connect(uri)
}

async function disconnect () {
  await mongoose.connection.dropDatabase()
  await mongoose.connection.close()
  await mongoServer.stop()
}

async function truncate (models = [UploadModel, DeploymentInfoModel]) {
  if (!Array.isArray(models)) {
    models = [models]
  }
  for (const model of models) {
    await model.deleteMany()
  }
}

module.exports = {
  connect,
  disconnect,
  truncate
}
