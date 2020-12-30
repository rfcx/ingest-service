const { PROMETHEUS_ENABLED, Histogram } = require('../utils/prometheus')
let exp = {
  PROMETHEUS_ENABLED
}

if (PROMETHEUS_ENABLED) {
  let histograms = {}

  function registerHistogram (name, help) {
    histograms[name] = new Histogram(name, help)
  }

  function pushHistogramMetric (histogramName, value) {
    const histogram = histograms[histogramName]
    if (!histogram) {
      throw new Error(`Histogram with name "${histogramName}" does not exist`)
    }
    histogram.push(value)
  }

  exp = {
    PROMETHEUS_ENABLED,
    registerHistogram,
    pushHistogramMetric
  }
}

module.exports = exp
