const audio = require('../services/audio')

audio.split('./example20mb.wav', './tmp', 20).then(result => {
  result.forEach(element => {
    console.log('success', element.path, element.duration)
  })
}).catch(err => {
  console.log(err.message)
})
