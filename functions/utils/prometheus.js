const PROMETHEUS_ENABLED = `${process.env.PROMETHEUS_ENABLED}` === 'true'
let exp = {
  PROMETHEUS_ENABLED
}

if (PROMETHEUS_ENABLED) {
  const client = require('prom-client')
  const env = process.env.NODE_ENV || 'dev'

  const register = new client.Registry()
  register.setDefaultLabels({
    app: `ingest-service-${env}`
  })
  client.collectDefaultMetrics({register})
  class Histogram {
    constructor (name, help) {
      if (!help) {
        help = `${name}_help`
      }
      this.histogram = new client.Histogram({
        name,
        help,
        buckets: [
          0.005, 0.05, 0.1, 0.25, 0.5,
          1, 1.5, 2, 2.5, 5, 7.5,
          10, 12.5, 15, 17.5, 20, 25, 30, 35, 40, 45, 50, 75,
          100, 150, 200, 250, 375, 500
        ],
      });
      register.registerMetric(this.histogram)
    }
    push (value) {
      this.histogram.observe(value)
    }
  }
  exp = {
    PROMETHEUS_ENABLED,
    register,
    Histogram
  }
}

module.exports = exp
