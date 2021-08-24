/**
 * Parses audio and stream data based on information stored in filename
 * @param {*} name example: p0gccfokn3p9_2014-12-31T21-04-10.261-0300_24kHz_90.923secs.opus
 * @returns {number} audio sample rate
 */
function getSampleRateFromFilename (name) {
  let sampleRate
  try {
    const matches = name.match(/_(?<sr>\d+\.*\d*)kHz_/i)
    if (matches.groups.sr) {
      sampleRate = matches.groups.sr * 1000
    }
  } catch (e) { }
  return sampleRate
}

module.exports = {
  getSampleRateFromFilename
}
