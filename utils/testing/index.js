const express = require('express')
const { connect, disconnect, truncate } = require('./db')

function startDb () {
  return connect()
}

function stopDb () {
  return disconnect()
}

function truncateDbModels (models) {
  return truncate(models)
}

const primaryUserId = 1
const primaryUserGuid = 'abc123'
const primaryUserEmail = 'jb@astonmartin.com'
const otherUserId = 2
const otherUserGuid = 'def456'
const anotherUserId = 3
const anotherUserGuid = 'ghy789'
const roleAdmin = 1
const roleMember = 2
const roleGuest = 3
const seedValues = { primaryUserId, primaryUserGuid, primaryUserEmail, otherUserId, otherUserGuid, anotherUserId, anotherUserGuid, roleAdmin, roleMember, roleGuest }

function expressApp (userAdditions = {}) {
  const app = express()
  app.use(express.json())
  app.use(express.urlencoded({ extended: false }))
  app.use((req, res, next) => {
    req.user = { id: primaryUserId, guid: primaryUserGuid, email: primaryUserEmail, ...userAdditions }
    next()
  })
  return app
}

function muteConsole (levels = ['log', 'info', 'warn', 'error']) {
  (typeof levels === 'string' ? [levels] : levels).forEach((f) => {
    console[f] = function () {}
  })
}

module.exports = {
  startDb,
  stopDb,
  truncateDbModels,
  expressApp,
  muteConsole,
  seedValues
}
