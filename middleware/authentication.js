const fs = require('fs')
const jwt = require('jsonwebtoken')
const path = require('path')
const cert = fs.readFileSync(path.join(process.cwd(), 'rfcx.pub'))

const verifyToken = function () {
  return function (req, res, next) {
    let token = req.headers.authorization
    if (!token) {
      return res.sendStatus(401)
    }
    if (token.startsWith('Bearer ')) { // Remove Bearer from string
      token = token.slice(7, token.length)
    }
    let decodedToken
    try {
      decodedToken = jwt.verify(token, cert)
    } catch (e) {
      return res.sendStatus(401)
    }
    if (!decodedToken) {
      res.sendStatus(403)
    } else {
      req.user = decodedToken
      next()
    }
  }
}

module.exports = {
  verifyToken
}
