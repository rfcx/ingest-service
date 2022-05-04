require('dotenv').config()

console.info('Tasks: starting')

const api = require('./routes/index-tasks')

const port = process.env.PORT || 3030
api.listen(port, () => {
  console.info(`App is listening on port ${port}`)
})

const ingestConsumer = require('./services/consumer/amazon')
ingestConsumer.start()
