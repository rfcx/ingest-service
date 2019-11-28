const fs = require('fs')
const dotenv = require('dotenv')

const variables = dotenv.parse(fs.readFileSync('.env'))
const json = { env: {} }
for (const key in variables) {
  json.env[key.toLowerCase()] = variables[key]
}

fs.writeFileSync('.runtimeconfig.json', JSON.stringify(json))
