const audio = require('../services/audio')

audio.split('./example20mb.wav', './tmp', 20).then(result => {
  result.forEach(element => {
    console.info('success', element.path, element.duration)
  })
}).catch(err => {
  console.error(err.message)
})
