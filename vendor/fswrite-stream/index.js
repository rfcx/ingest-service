const fs = require('fs')
const lengthStream = require('length-stream')

// Write a stream to a file
//
// rfcx patch (2026-09-04), two changes to the upstream 1.0.0 module:
//
// 1. Pipe at CALL time, not inside `wstream.on('open')`. fs.WriteStream buffers
//    writes until its fd is open, so deferring the pipe buys nothing — and it
//    opened a race: nuts-serve hands ONE request stream to this module AND to
//    stream-res (which pipes immediately). If the fs open callback landed after
//    response data had started flowing, request@2.x's pipe() emitted
//    "You cannot pipe after data has been emitted" and RETURNED UNDEFINED
//    (its error branches have no `return`), and the original line 35 did
//    `undefined.pipe(wstream)` inside an fs completion callback with nothing on
//    the stack to catch it => uncaughtException => process exit. Attaching
//    synchronously means both consumers are registered before any data moves.
//
// 2. Guard the intermediate anyway and SETTLE the callback (single-shot via
//    `settled`). A bare `if (!piped) return` would leave lru-diskcache's Q
//    deferred unresolved forever (a leaked HTTP request); and request.pipe
//    emits 'error' synchronously before returning, so the existing 'error'
//    listener and the guard can both fire for one failure.
function writeStream (filename, rstream, opts, callback) {
  if (!callback) {
    callback = opts
    opts = {}
  }

  let size = 0
  let settled = false
  const wstream = fs.createWriteStream(filename, opts)
  const lstream = lengthStream(function (length) {
    size = length
  })

  function cleanup () {
    lstream.removeAllListeners()
    wstream.removeAllListeners()
    rstream.removeAllListeners()
  }

  function settle (err, result) {
    if (settled) { return }
    settled = true
    cleanup()
    callback(err, result)
  }

  function onError (err) {
    settle(err)
  }

  lstream.on('error', onError)
  wstream.on('error', onError)
  rstream.on('error', onError)

  wstream.on('finish', function () {
    settle(null, size)
  })

  const piped = rstream.pipe(lstream)
  if (!piped) {
    return settle(new Error('fswrite-stream: source stream refused to pipe (pipe() returned ' + piped + ')'))
  }
  piped.pipe(wstream)
}

module.exports = writeStream
