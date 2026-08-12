// ---------------------------------------------------------------------------
// Which upload-store backend is selected (mongo2pg S1).
//
// Single source of truth for reading the UPLOADS_DB flag, so the entrypoints,
// the backend switch and any future consumer cannot drift on how it is parsed
// (e.g. one honouring 'PG' and another not).
//
// Default is 'mongo': with UPLOADS_DB unset, behaviour is unchanged.
// ---------------------------------------------------------------------------

function uploadsDbEngine () {
  return (process.env.UPLOADS_DB || 'mongo').toLowerCase()
}

function isPostgresUploads () {
  return uploadsDbEngine() === 'pg'
}

module.exports = {
  uploadsDbEngine,
  isPostgresUploads
}
