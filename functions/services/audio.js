const probe = require('ffmpeg-probe')
const fs = require('fs')
const ffmpeg = require('fluent-ffmpeg')

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
 * Split an audio file into segments of a maximum duration
 * - if the source file is longer than the maximum duration then it will be cut into segments of maximum duration in length
 * - the last output file may be shorter than the maximum duration
 * @param {String} sourceFile - path to source file on disk
 * @param {String} destinationPath - path (directory) to output the file segments
 * @param {Number} maxDuration - the maximum duration of a segment
 * @returns {Object[]} - array with objects with segments information (local path, duration)
 */
function split (sourceFile, destinationPath, maxDuration) {
  destinationPath += destinationPath.endsWith('/') ? '' : '/'
  const outputFileFormat = destinationPath + sourceFile.replace(/\.([^.]*)$/, '.%03d.$1') // convert hello.wav to hello.%03d.wav

  return new Promise((resolve, reject) => {
    const command = ffmpeg(sourceFile)
      .noVideo()
      .audioCodec('copy')
      .output(outputFileFormat)
      .outputOptions([
        '-f segment', // output as file segments
        `-segment_time ${maxDuration}`, // split into X sec segments
        // '-segment_frames 0,24000,48000' // split into segments by frame boundaries - maybe useful in future
        '-segment_list pipe:1' // output a list of the created segments to stdout
      ]).on('start', function (commandLine) {
        console.log('Spawned Ffmpeg with command: ' + commandLine)
      }).on('progress', function (progress) {
        console.log('Processing: ' + progress.percent + '% done')
      })

    const timeout = setTimeout(function () {
      command.kill()
      reject(Error('Timeout')) // TODO: move to errors
    }, 60000)

    command.on('error', function (err, stdout, stderr) {
      clearTimeout(timeout)
      reject(err)
    }).on('end', function (stdout, stderr) {
      clearTimeout(timeout)
      const outputFiles = stdout.trim().split('\n').map(x => {
        return { path: x, duration: maxDuration }
      })
      resolve(outputFiles)
    }).run()
  })
}

module.exports = {
  identify,
  split
}
