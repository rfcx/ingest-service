if (process.env.NODE_ENV === 'production') {
  require('./newrelic')
}
require('dotenv').config()

console.info('API: starting')
require('./utils/mongo')
const api = require('./routes')

const port = process.env.PORT || 3030
api.listen(port, () => {
  console.info(`App is listening on port ${port}`)
})
