const { PubSub } = require('@google-cloud/pubsub')
const { ingest } = require('../rfcx/ingest')
const { parseUploadFromFileName } = require('./misc')

async function messageHandler (message) {
  const messageData = JSON.parse(message.data)
  const fileName = messageData.name
  const { fileLocalPath, streamId, uploadId } = parseUploadFromFileName(fileName)
  await ingest(fileName, fileLocalPath, streamId, uploadId)
  message.ack() // "Ack" (acknowledge receipt of) the message
}

function start () {
  const subscriptionName = process.env.GCLOUD_SUBSCRIPTION_NAME
  const pubSubClient = new PubSub()
  const subscription = pubSubClient.subscription(subscriptionName)
  subscription.on('message', messageHandler)
  console.log(`PubSub is listening to messages in subscription "${subscriptionName}"`)
}

module.exports = {
  start
}
