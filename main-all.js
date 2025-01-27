if (process.env.NODE_ENV === 'production') {
  require('newrelic')
}
require('dotenv').config()

console.info('API and Tasks: starting')

const api = require('./routes')

async function main () {
  const port = process.env.PORT || 3030
  api.listen(port, () => {
    console.info(`App is listening on port ${port}`)
  })

  const ingestConsumer = require('./services/consumer/amazon')
  ingestConsumer.start()
}

main()
