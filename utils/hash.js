const csprng = require('csprng')

function randomHash (bits) {
  return csprng(bits, 36)
}

function randomString (length) {
  return this.randomHash(320).substr(0, length)
}

module.exports = {
  randomHash,
  randomString
}
