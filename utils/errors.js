const db = require('../services/db/uploads')
const { ValidationError, EmptyResultError, ForbiddenError, UnauthorizedError } = require('@rfcx/http-utils')

class IngestionError extends Error {
  constructor (message, status) {
    super(message)
    this.name = 'IngestionError'
    this.status = status || db.status.FAILED
  }
}

// A request that is well-formed and AUTHORISED but conflicts with existing
// state -- e.g. "another file already occupies this exact timestamp in the
// stream". This is a 409, not a 403: the caller's *permission* is fine, the
// *data* collides. `@rfcx/http-utils` (^1.0.12) has no Conflict concept, so it
// is defined here.
//
// WHY THIS MATTERS (2026-09-02): Core signalled that collision as a 403.
// The web uploader classifies 403 as "auth/congestion, DO retry" (upload-engine
// RETRYABLE_CLIENT_STATUSES = {401,403,408,429}) and retried ONE file 801
// times in 21 minutes while the user saw nothing actionable. The same engine
// treats any other 4xx as permanent, so a 409 makes it stop after one attempt
// and surface the server's message -- by the design already in place.
class ConflictError extends Error {
  constructor (message) {
    super(message)
    this.message = message
    this.name = 'ConflictError'
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
      case 409:
        // Without this case a Core 409 fell through to `default: return err`
        // (the raw axios error), which httpErrorHandler renders as a 500 with
        // a generic fallback message -- so a correctly-classified conflict
        // upstream would have become a WORSE error here. Map it explicitly.
        return new ConflictError(message)
      default:
        return err
    }
  } catch (e) {
    return err
  }
}

module.exports = {
  IngestionError,
  ForbiddenError,
  ConflictError,
  matchAxiosErrorToRfcx
}
