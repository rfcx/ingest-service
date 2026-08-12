// Last-resort process-level handlers.
//
// Express's error middleware should always be the first line of
// defence, but bugs that throw *after* `res.headersSent` (e.g. a
// `res.status(...).json(...)` inside the error handler while a
// download response is already streaming) escape Express entirely
// and become an `uncaughtException`. Without a handler, Node logs a
// terse stack and exits with code 1, taking the pod with it. With a
// handler we at least leave a structured log line behind so the
// next operator can identify the offending route in seconds rather
// than minutes.
//
// We do NOT swallow the error — best practice is still to exit on
// uncaughtException because the process state is undefined. We just
// add diagnostic context first.

function installProcessHandlers (label) {
  process.on('uncaughtException', (err, origin) => {
    console.error('Uncaught exception (will exit)', {
      service: label,
      origin,
      message: err && err.message,
      stack: err && err.stack
    })
    process.exit(1)
  })

  process.on('unhandledRejection', (reason) => {
    // Exit (like uncaughtException above) instead of only logging. A silently-
    // swallowed rejection previously left the process running in an undefined
    // state — most damagingly, an initial RabbitMQ connect failure that left
    // the consumer pod up but NOT consuming (queue stalled at 0 consumers, pod
    // looked healthy). Exiting lets kubernetes restart the pod, which (with the
    // consumer's reconnect-with-backoff) recovers cleanly. Process state after
    // an unhandled rejection is undefined, so continuing is never safe.
    console.error('Unhandled promise rejection (will exit)', {
      service: label,
      message: reason && reason.message,
      stack: reason && reason.stack,
      reason: typeof reason === 'object' ? undefined : reason
    })
    process.exit(1)
  })
}

module.exports = { installProcessHandlers }
