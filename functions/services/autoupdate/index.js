if (process.env.AUTOUPDATE_ENABLED === 'true') {
  const { Nuts } = require('nuts-serve')
  const nuts = Nuts({
    repository: process.env.AUTOUPDATE_GITHUB_REPO,
    token: process.env.AUTOUPDATE_GITHUB_TOKEN,
    refreshSecret: process.env.AUTOUPDATE_GITHUB_SECRET
  })
  module.exports = { AUTOUPDATE_ENABLED: true, router: nuts.router }
} else {
  module.exports = { AUTOUPDATE_ENABLED: false }
}
