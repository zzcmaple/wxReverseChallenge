const { uploadAudio, callFunction } = require("../../utils/cloud");

const recorderManager = wx.getRecorderManager();
const previewAudio = wx.createInnerAudioContext();
const fileSystemManager = wx.getFileSystemManager();

let timer = null;
let pcmFrames = [];

function formatDuration(ms) {
  const totalSeconds = Math.floor((ms || 0) / 1000);
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function concatArrayBuffers(buffers) {
  const totalLength = buffers.reduce((sum, item) => sum + item.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;

  buffers.forEach((buffer) => {
    result.set(new Uint8Array(buffer), offset);
    offset += buffer.byteLength;
  });

  return result.buffer;
}

function createWavArrayBuffer(pcmBuffer, sampleRate = 16000, channels = 1, bitsPerSample = 16) {
  const pcmByteLength = pcmBuffer.byteLength;
  const headerBuffer = new ArrayBuffer(44);
  const view = new DataView(headerBuffer);
  const byteRate = sampleRate * channels * bitsPerSample / 8;
  const blockAlign = channels * bitsPerSample / 8;

  function writeString(offset, text) {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  }

  writeString(0, "RIFF");
  view.setUint32(4, 36 + pcmByteLength, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(36, "data");
  view.setUint32(40, pcmByteLength, true);

  const wavBytes = new Uint8Array(44 + pcmByteLength);
  wavBytes.set(new Uint8Array(headerBuffer), 0);
  wavBytes.set(new Uint8Array(pcmBuffer), 44);

  return wavBytes.buffer;
}

function writeWavFile(arrayBuffer) {
  const filePath = `${wx.env.USER_DATA_PATH}/record-${Date.now()}.wav`;

  return new Promise((resolve, reject) => {
    fileSystemManager.writeFile({
      filePath,
      data: arrayBuffer,
      success: () => resolve(filePath),
      fail: reject
    });
  });
}

Page({
  data: {
    isRecording: false,
    loading: false,
    submitting: false,
    statusText: "准备开始",
    duration: 0,
    formattedDuration: "00:00",
    tempFilePath: "",
    isPreviewPlaying: false,
    previewProgress: 0,
    previewCurrentTimeText: "00:00",
    previewDurationText: "00:00"
  },

  onLoad() {
    previewAudio.obeyMuteSwitch = false;
    previewAudio.autoplay = false;

    recorderManager.onStart(() => {
      pcmFrames = [];
      this.setData({
        isRecording: true,
        statusText: "录音中，请开始说话",
        duration: 0,
        formattedDuration: "00:00",
        tempFilePath: "",
        isPreviewPlaying: false,
        previewProgress: 0,
        previewCurrentTimeText: "00:00",
        previewDurationText: "00:00"
      });
      this.startTimer();
    });

    recorderManager.onStop(async () => {
      this.stopTimer();

      try {
        previewAudio.pause();
      } catch (error) {
        console.warn("暂停试听失败", error);
      }

      try {
        const pcmBuffer = concatArrayBuffers(pcmFrames);
        const wavBuffer = createWavArrayBuffer(pcmBuffer, 16000, 1, 16);
        const wavFilePath = await writeWavFile(wavBuffer);

        this.setData({
          isRecording: false,
          loading: false,
          statusText: "录音完成，可以试听或上传",
          tempFilePath: wavFilePath,
          isPreviewPlaying: false,
          previewProgress: 0,
          previewCurrentTimeText: "00:00",
          previewDurationText: this.data.formattedDuration
        });
      } catch (error) {
        this.setData({
          isRecording: false,
          loading: false,
          statusText: "录音转换失败，请重试"
        });
        wx.showToast({
          title: error.errMsg || error.message || "录音处理失败",
          icon: "none"
        });
      }
    });

    recorderManager.onError((error) => {
      this.stopTimer();
      this.setData({
        isRecording: false,
        loading: false,
        statusText: "录音失败，请重试"
      });
      wx.showToast({
        title: error.errMsg || "录音失败",
        icon: "none"
      });
    });

    recorderManager.onFrameRecorded((res) => {
      if (res.frameBuffer) {
        pcmFrames.push(res.frameBuffer);
      }
    });

    previewAudio.onCanplay(() => {
      const durationSeconds = Math.floor(previewAudio.duration || 0);
      if (!durationSeconds) {
        return;
      }

      this.setData({
        previewDurationText: formatDuration(durationSeconds * 1000)
      });
    });

    previewAudio.onPlay(() => {
      this.setData({
        isPreviewPlaying: true
      });
    });

    previewAudio.onTimeUpdate(() => {
      const currentTime = Math.floor(previewAudio.currentTime || 0);
      const durationSeconds = Math.floor(previewAudio.duration || 0);
      const progress = durationSeconds ? (currentTime / durationSeconds) * 100 : 0;

      this.setData({
        isPreviewPlaying: true,
        previewProgress: Math.min(progress, 100),
        previewCurrentTimeText: formatDuration(currentTime * 1000),
        previewDurationText: durationSeconds
          ? formatDuration(durationSeconds * 1000)
          : this.data.previewDurationText
      });
    });

    previewAudio.onEnded(() => {
      this.setData({
        isPreviewPlaying: false,
        previewProgress: 100,
        previewCurrentTimeText: this.data.previewDurationText
      });
    });

    previewAudio.onPause(() => {
      this.setData({
        isPreviewPlaying: false
      });
    });

    previewAudio.onStop(() => {
      this.setData({
        isPreviewPlaying: false
      });
    });

    previewAudio.onError((error) => {
      this.setData({
        isPreviewPlaying: false
      });
      wx.showToast({
        title: error.errMsg || "试听失败",
        icon: "none"
      });
    });
  },

  onUnload() {
    this.stopTimer();
    previewAudio.destroy();
  },

  startTimer() {
    this.stopTimer();
    timer = setInterval(() => {
      const duration = this.data.duration + 1000;
      this.setData({
        duration,
        formattedDuration: formatDuration(duration)
      });
    }, 1000);
  },

  stopTimer() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  },

  startRecording() {
    this.setData({
      loading: true,
      statusText: "正在申请录音权限"
    });

    wx.authorize({
      scope: "scope.record",
      success: () => {
        this.setData({
          loading: false
        });
        recorderManager.start({
          duration: 60000,
          format: "pcm",
          sampleRate: 16000,
          numberOfChannels: 1,
          encodeBitRate: 64000,
          frameSize: 50,
          frameFormatPcm: true
        });
      },
      fail: () => {
        this.setData({
          loading: false,
          statusText: "需要录音权限才能继续"
        });
        wx.showModal({
          title: "需要录音权限",
          content: "请在设置里允许小程序访问麦克风。",
          showCancel: false
        });
      }
    });
  },

  stopRecording() {
    recorderManager.stop();
  },

  playPreview() {
    if (!this.data.tempFilePath) {
      return;
    }

    if (this.data.isPreviewPlaying) {
      previewAudio.pause();
      return;
    }

    if (previewAudio.src !== this.data.tempFilePath) {
      previewAudio.src = this.data.tempFilePath;
      this.setData({
        previewProgress: 0,
        previewCurrentTimeText: "00:00",
        previewDurationText: this.data.formattedDuration
      });
    }

    previewAudio.play();
  },

  async submitAudio() {
    if (!this.data.tempFilePath || this.data.submitting) {
      wx.showToast({
        title: this.data.tempFilePath ? "生成中" : "请先录音",
        icon: "none"
      });
      return;
    }

    this.setData({
      submitting: true,
      statusText: "上传音频中"
    });

    wx.showLoading({
      title: "生成中"
    });

    try {
      const uploadRes = await uploadAudio(this.data.tempFilePath);
      const result = await callFunction("processAudio", {
        originalFileID: uploadRes.fileID,
        duration: this.data.duration
      });

      wx.hideLoading();
      this.setData({
        submitting: false,
        statusText: "生成完成"
      });

      wx.navigateTo({
        url: `/pages/detail/detail?id=${result.recordId}`
      });
    } catch (error) {
      wx.hideLoading();
      this.setData({
        submitting: false,
        statusText: "处理失败，请稍后重试"
      });

      wx.showToast({
        title: error.message || "提交失败",
        icon: "none"
      });
    }
  },

  goHistory() {
    wx.navigateTo({
      url: "/pages/history/history"
    });
  }
});
