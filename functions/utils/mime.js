function mimeTypeFromAudioCodec(audioCodec) {

  if (audioCodec.toLowerCase() == "aac" ||
      audioCodec.toLowerCase() == "mp4") {
    return "audio/mp4";
  }
  else if (audioCodec.toLowerCase() == "opus") {
    return "audio/ogg";
  }
  else if (audioCodec.toLowerCase() == "flac") {
    return "audio/flac";
  }
  else if (audioCodec.toLowerCase() == "mp3") {
    return "audio/mpeg";
  }
  else if (audioCodec.toLowerCase() == "wav") {
    return "audio/vnd.wav";
  }
  else if (audioCodec.toLowerCase() == "m3u") {
    return "audio/x-mpegurl";
  }
  else if (audioCodec.toLowerCase() == "aiff" ||
           audioCodec.toLowerCase() == "aif" ||
           audioCodec.toLowerCase() == "aifc") {
    return "audio/x-aiff";
  }
  else {
    return null;
  }

};

module.exports = {
  mimeTypeFromAudioCodec,
}
