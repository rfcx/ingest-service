const moment = require('moment')

/**
 * Parses audio and stream data based on information stored in filename
 * @param {*} name example: p0gccfokn3p9_2014-12-31T21-04-10.261-0300_24kHz_90.923secs.opus
 * @returns {Object} data parsed guardian audio data
 * @returns {string} data.streamId guardian/stream id
 * @returns {Moment} data.timestamp moment.js object with datetime
 * @returns {number} data.sampleRate audio sample rate
 * @returns {number} data.duration audio duration
 */
function parseGuardianAudioFilename (name) {
  let streamId, timestamp, sampleRate, duration
  try {
    const matches = name.match(/^(?<id>(\d|\w{12}))_(?<ts>\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}.\d{3}-\d{4})_(?<sr>\d+)kHz_(?<du>\d+.\d+)secs/)
    const { id, ts, sr, du } = matches.groups
    streamId = id
    timestamp = moment(ts, 'YYYY-MM-DDTHH-mm-ss.SSSZZ')
    sampleRate = sr * 1000
    duration = parseFloat(du)
    if (!streamId || !timestamp || !sampleRate || !duration) { // if some of the fields were parsed incorrectly, reset other fields
      streamId = undefined
      timestamp = undefined
      sampleRate = undefined
      duration = undefined
    }
  } catch (e) { }
  return { streamId, timestamp, sampleRate, duration }
}

module.exports = {
  parseGuardianAudioFilename
}
