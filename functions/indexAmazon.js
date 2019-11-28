require('dotenv').config()

const api = require('./api')

const port = process.env.PORT || 3030
api.listen(port, function () {
  console.log(`App is listening on port ${port}`)
})