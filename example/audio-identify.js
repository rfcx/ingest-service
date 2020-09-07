const audio = require('../functions/services/audio')

audio.identify('./example20mb.wav').then(result => {
  console.log(JSON.stringify(result))
}).catch(err => {
  console.error(err.message)
})