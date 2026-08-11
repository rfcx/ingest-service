// ---------------------------------------------------------------------------
// Upload-store backend switch (mongo2pg S1).
//
// Selects the MongoDB or PostgreSQL implementation of the upload store at
// require time. Default is 'mongo' — behaviour is bit-identical to before this
// module existed unless UPLOADS_DB is explicitly set to 'pg'.
//
// Every consumer requires THIS module rather than a concrete backend, so the
// cutover (and its rollback) is an env-var change with no code deploy.
//
// Note this is resolved once at require time, not per call: the backend cannot
// change under a running process, which is what we want — a mid-process switch
// would split one request's reads and writes across two engines.
// ---------------------------------------------------------------------------

const { isPostgresUploads } = require('../../utils/uploads-db')

module.exports = isPostgresUploads()
  ? require('./uploads-pg')
  : require('./mongo')
