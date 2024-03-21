const PROMETHEUS_ENABLED = `${process.env.PROMETHEUS_ENABLED}` === 'true'
let exp = {
  PROMETHEUS_ENABLED
}

if (PROMETHEUS_ENABLED) {
  const { Histogram, Gauge, getRegister } = require('@rfcx/prometheus-metrics')
  const registerName = `ingest-service-${process.env.NODE_ENV || 'dev'}`
  const register = getRegister(registerName)
  const db = require('../services/db/mongo')

  new Gauge(registerName, 'uploads_failed', 'Number or failed uploads', db.getUploadFailedCount) // eslint-disable-line no-new
  new Gauge(registerName, 'uploads_duplicated', 'Number or duplicated uploads', db.getUploadDuplicateCount) // eslint-disable-line no-new

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

module.exports = exp
