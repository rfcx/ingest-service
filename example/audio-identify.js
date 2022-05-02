const audio = require('../services/audio')

audio.identify('./example20mb.wav').then(result => {
  console.info(JSON.stringify(result))
}).catch(err => {
  console.error(err.message)
})
