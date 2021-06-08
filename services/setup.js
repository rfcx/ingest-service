const dirUtil = require('../utils/dir')

module.exports = async function () {
  await dirUtil.ensureDirExists(process.env.CACHE_DIRECTORY)
}
