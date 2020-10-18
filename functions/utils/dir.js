const path = require('path')
const fs = require('fs')
const rimraf = require('rimraf')

function ensureDirExists (dirPath) {
  return new Promise((resolve, reject) => {
    try {
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath)
      }
      resolve()
    } catch (e) {
      reject(e)
    }
  })
}

function removeDirRecursively (path) {
  return new Promise((resolve, reject) => {
    rimraf(path, (err) => {
      if (err) {
        reject(err)
      } else {
        resolve()
      }
    })
  })
}

module.exports = {
  ensureDirExists,
  removeDirRecursively
}
