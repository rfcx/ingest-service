const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server')
const UploadModel = require('../../services/db/models/mongoose/upload').Upload
const DeploymentInfoModel = require('../../services/db/models/mongoose/deploymentInfo').DeploymentInfo

const mongoServer = new MongoMemoryServer()

async function connect () {
  const uri = await mongoServer.getUri()
  const mongooseOpts = {
    useNewUrlParser: true,
    useCreateIndex: true,
    useUnifiedTopology: true,
    useFindAndModify: false
  };
  await mongoose.connect(uri, mongooseOpts)
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
  for (let model of models) {
    await model.remove({})
  }
}

module.exports = {
  connect,
  disconnect,
  truncate
}
