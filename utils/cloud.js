function callFunction(name, data = {}) {
  return wx.cloud.callFunction({
    name,
    data
  }).then((res) => res.result);
}

function uploadAudio(filePath) {
  const ext = filePath.split(".").pop() || "mp3";
  const cloudPath = `audio/original/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

  return wx.cloud.uploadFile({
    cloudPath,
    filePath
  });
}

module.exports = {
  callFunction,
  uploadAudio
};
