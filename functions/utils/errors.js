const db = require('../services/db/mongo')
const path = require('path')
const fs = require('fs')
const dirUtil = require('../utils/dir')
const { ValidationError, EmptyResultError, ForbiddenError, UnauthorizedError } = require('@rfcx/http-utils')

class IngestionError extends Error {
  constructor (message, status) {
    super(message)
    this.name = 'IngestionError'
    this.status = status || db.status.FAILED
  }
}

function matchAxiosErrorToRfcx (err) {
  try {
    const statusCode = err.response.status
    let message
    try {
      message = err.response.data.message
    } catch (mesErr) {
      message = err.message
    }
    switch (statusCode) {
      case 400:
        return new ValidationError(message)
      case 401:
        return new UnauthorizedError(message)
      case 403:
        return new ForbiddenError(message)
      case 404:
        return new EmptyResultError(message)
      default:
        return err
    }
  } catch (e) {
    return err
  }
}

async function createErrorTextFile (error, localPath) {
  const dir = path.dirname(localPath)
  await dirUtil.ensureDirExists(dir)
  return new Promise((resolve, reject) => {
    fs.writeFile(localPath, `message: ${error.message} stack: ${error.stack}`, (err) => {
      if (err) {
        console.log('write error stack file failed')
        reject(err)
      } else {
        console.log('write error stack file success')
        resolve()
      }
    })
  })
}

module.exports = {
  IngestionError,
  matchAxiosErrorToRfcx,
  createErrorTextFile
}
