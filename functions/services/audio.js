const probe = require('ffmpeg-probe')
const fs = require('fs')

/* Run sox (or in this case ffmpeg) to get the sample rate and duration
** results looks like:
** { format: 'wav', duration: 1.5, sampleCount: 66150, channelCount: 1, bitRate: 722944, sampleRate: 44100 }
*/
function identify (filePath) {
  return probe(filePath).then(result => {
    console.log('\n\nresult', result, '\n\n')
    const stream = result.streams[0]
    const format = result.format.format_name
    const duration = stream.duration
    const sampleCount = stream.duration_ts
    const channelCount = stream.channels
    const channelLayout = stream.channel_layout
    const bitRate = stream.bit_rate
    const sampleRate = stream.sample_rate
    const codec = stream.codec_name
    return { format, duration, sampleCount, channelLayout, channelCount, bitRate, sampleRate, codec }
  })
}

/**
 *
 * @param {String} sourceFile - path to source file on disk
 * @returns {Object[]} splittedFiles - array with objects with segments information (local path, duration, start, end timestamps)
 */
function split (sourceFile, destinationPath, maxDuration) {
  console.log('split file', sourceFile)
  const destinationFile = destinationPath + '/' + sourceFile
  fs.copyFileSync(sourceFile, destinationFile)
  return Promise.resolve([{ path: destinationFile, duration: maxDuration }])
}

module.exports = {
  identify,
  split
}
