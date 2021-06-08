module.exports = (func, ms) => {
  return context => {
    return new Promise(function (resolve, reject) {
      setTimeout(() => { func(context).then(resolve).catch(reject) }, ms)
    })
  }
}
