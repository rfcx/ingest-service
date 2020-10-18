require('dotenv').config()

const platform = process.env.PLATFORM
console.log(`Environment set to ${platform}`)

const api = require('./api')

const port = process.env.PORT || 3030
api.listen(port, () => {
  console.log(`App is listening on port ${port}`)
})

const ingestConsumer = require(`./services/consumer/${platform}`)
ingestConsumer.start()
