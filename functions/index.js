require('dotenv').config()

if (process.env.PLATFORM === 'google') {
  console.log('Environment set to google, but running as Node.js app')
}

const api = require('./api')

const port = process.env.PORT || 3030
api.listen(port, function () {
  console.log(`App is listening on port ${port}`)
})