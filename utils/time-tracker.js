const IS_ENABLED = `${process.env.TIME_TRACKER_ENABLED}` === 'true'

class TimeTrackerStub {
  setPoint () {}
  log () {}
  logAndSetNewPoint () {}
}

class TimeTracker {
  constructor (title) {
    this.title = title
    this.setPoint()
  }

  setPoint () {
    this.currentTimestamp = Date.now()
  }

  log (message) {
    console.log(`-- [${this.title}]: ${message}: ${(Date.now() - this.currentTimestamp) / 1000}s`)
  }

  logAndSetNewPoint (message) {
    this.log(message)
    this.setPoint()
  }
}

module.exports = IS_ENABLED ? TimeTracker : TimeTrackerStub
