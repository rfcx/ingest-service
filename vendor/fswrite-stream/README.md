# vendored `fswrite-stream` (rfcx fork of `SamyPesse/fswrite-stream@1.0.0`)

**Why this exists.** `ingest-service-api` serves the desktop uploader's autoupdate
feed through `nuts-serve`, whose asset cache (`lru-diskcache`) writes each
downloaded release asset to disk with `fswrite-stream`. Upstream 1.0.0 (the only
version ever published, last touched 2016) pipes the source stream *inside the
fs `'open'` callback*. `nuts-serve` hands the same `request` stream to a second
consumer (`stream-res`) that pipes immediately, so whenever the fs open callback
landed after response data had started flowing, `request@2.60.0`'s `pipe()`
emitted `'error'` **and returned `undefined`** (its error branches have no
`return`), and upstream's `undefined.pipe(wstream)` threw inside an fs completion
callback with nothing on the stack to catch it. That is an `uncaughtException`,
which `utils/process-handlers.js` (correctly) turns into `process.exit(1)` —
**the api pod died, taking every in-flight request with it**, on roughly one
asset download in a few hundred, clustered on days when node I/O was slow.

Record: `runbooks/FINDING-2026-09-04-fswrite-stream-uncaught-crash-class.md`
in `evity-squibbon/rfcx-local`.

**What changed vs upstream** (see the header comment in `index.js`):

1. Pipe at call time, not in `wstream.on('open')`. `fs.WriteStream` buffers until
   its fd is open, so the deferral bought nothing and created the race. Both
   consumers are now registered before any byte moves — the race is removed,
   not just guarded.
2. Guard the `pipe()` return value and **settle** the callback (single-shot via a
   `settled` flag). A bare bail would leave `lru-diskcache`'s promise unresolved
   forever (a leaked HTTP request); and `request.pipe` emits `'error'`
   synchronously before returning, so the guard and the `'error'` listener can
   both fire for one failure.

**How it is wired in.** `package.json` `resolutions` points `fswrite-stream` at
`file:./vendor/fswrite-stream`; `yarn.lock` records it as `1.0.0-rfcx.1`. The
registry package is no longer fetched. Nothing else in the dependency tree
changed. Remove the `resolutions` entry + this directory to go back to upstream.

**Tests.** `index.test.js` runs with the rest of the jest suite. The two-consumer
cases execute out of process (`race-runner.js`) against the real `request` and
`stream-res` from `node_modules`, because jest-circus catches `uncaughtException`
inside its sandbox and would hide the crash the RED control exists to prove.

**License.** Apache-2.0, as upstream (`SamyPesse/fswrite-stream`). Copyright
Samy Pesse; modifications 2026 Rainforest Connection.