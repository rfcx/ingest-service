const PROMETHEUS_ENABLED = `${process.env.PROMETHEUS_ENABLED}` === 'true'
let exp = {
  PROMETHEUS_ENABLED
}

// ---------------------------------------------------------------------------
// Gauge collectors must FAIL SOFT — a metrics scrape must never kill the process.
//
// THE BUG THIS FIXES (observed in production 2026-08-17/18, ~20 restarts on each
// ingest-service-api replica and 14 on a tasks pod):
//
//   @rfcx/prometheus-metrics `Gauge` takes a callback and awaits it inside
//   prom-client's `collect()` with NO error handling:
//
//       async collect () { const currentValue = await func(); this.set(currentValue) }
//
//   prom-client gathers gauges under `Promise.all` in `registry.metrics()`, so a
//   rejected callback becomes an UNHANDLED REJECTION. `utils/process-handlers.js`
//   deliberately calls `process.exit(1)` on unhandledRejection (correct for the
//   consumer — a swallowed rejection once left a pod up but NOT consuming), so a
//   transient DB blip during a /metrics scrape TOOK THE POD DOWN:
//
//       error: GET 500 /health-check Response Time: 2003
//       Unhandled promise rejection (will exit)
//         message: 'Connection terminated due to connection timeout'
//         at async Gauge.collect (@rfcx/prometheus-metrics/index.js:40:30)
//         at async Promise.all (index 31)
//
//   Prometheus scrapes every 30s (platform/monitoring/43-ingest-servicemonitors.yaml),
//   which made observability a LIVENESS DEPENDENCY on Postgres. The 2001-2003ms
//   timings are exactly the pool's `connectionTimeoutMillis: 2000` — failures to
//   ACQUIRE a connection, not slow queries (the gauge queries themselves are
//   index-only and take 0.3-2.1ms against `stream_uploads_gauge_status_idx`).
//
// THE FIX: wrap each collector so a failure yields a STALE/ZERO sample and a log
// line instead of an unhandled rejection. These are advisory counters; losing one
// scrape is a non-event, losing the pod is not.
//
// WHY LAST-GOOD RATHER THAN 0: returning 0 on failure makes the gauge briefly LIE
// (a dip to zero), which is indistinguishable from "the failure count really did
// drop to zero" and could quietly satisfy or fire threshold alerts. Serving the
// last good value keeps the series flat across a blip — visibly stale rather than
// actively wrong. Before the first successful read there is no last-good value,
// so we return 0 and say so in the log.
//
// NOTE the deliberate non-goals: the short `connectionTimeoutMillis` stays (the
// readinessProbe with failureThreshold:1 shares this pool, so a long connect
// timeout would turn a brief blip into a rolling readiness failure), and the
// unhandledRejection->exit policy stays everywhere else.
//
// Ref: runbooks/FINDING-ingest-api-metrics-crashloop-2026-08-18.md (rfcx-local)
// ---------------------------------------------------------------------------
function nonFatalCollector (fn, label) {
  let lastGood
  return async () => {
    try {
      const value = await fn()
      // Guard against a backend returning a non-number (pg returns bigint as a
      // string; the pg impl already Number()s it, but a future backend might not).
      // prom-client would throw on a non-number, back inside the same
      // unhandled-rejection path this wrapper exists to prevent.
      const numeric = Number(value)
      if (!Number.isFinite(numeric)) {
        throw new Error(`collector returned a non-numeric value: ${JSON.stringify(value)}`)
      }
      lastGood = numeric
      return numeric
    } catch (err) {
      const detail = lastGood === undefined
        ? 'no previous value yet, reporting 0'
        : `reporting last good value ${lastGood}`
      console.error(`[metrics] gauge "${label}" collect failed (non-fatal, ${detail}):`, err && err.message)
      return lastGood === undefined ? 0 : lastGood
    }
  }
}

if (PROMETHEUS_ENABLED) {
  const { Histogram, Gauge, getRegister } = require('@rfcx/prometheus-metrics')
  const registerName = `ingest-service-${process.env.NODE_ENV || 'dev'}`
  const register = getRegister(registerName)
  const db = require('../services/db/uploads')

  new Gauge(registerName, 'uploads_failed', 'Number or failed uploads', nonFatalCollector(db.getUploadFailedCount, 'uploads_failed')) // eslint-disable-line no-new
  new Gauge(registerName, 'uploads_duplicated', 'Number or duplicated uploads', nonFatalCollector(db.getUploadDuplicateCount, 'uploads_duplicated')) // eslint-disable-line no-new

  const histograms = {}

  function registerHistogram (name, help, buckets) { // eslint-disable-line no-inner-declarations
    histograms[name] = new Histogram(registerName, name, help, buckets)
  }

  function pushHistogramMetric (histogramName, value) { // eslint-disable-line no-inner-declarations
    const histogram = histograms[histogramName]
    if (!histogram) {
      throw new Error(`Histogram with name "${histogramName}" does not exist`)
    }
    histogram.push(value)
  }

  exp = {
    PROMETHEUS_ENABLED,
    registerHistogram,
    pushHistogramMetric,
    register
  }
}

// Exported unconditionally (and regardless of PROMETHEUS_ENABLED) so it is
// unit-testable without standing up a register or a database.
exp.nonFatalCollector = nonFatalCollector

module.exports = exp
