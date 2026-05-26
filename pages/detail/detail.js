const { callFunction, uploadAudio } = require("../../utils/cloud");

const detailAudio = wx.createInnerAudioContext();
const recorderManager = wx.getRecorderManager();
const previewAudio = wx.createInnerAudioContext();
const fileSystemManager = wx.getFileSystemManager();

let mimicTimer = null;
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
  const filePath = `${wx.env.USER_DATA_PATH}/mimic-${Date.now()}.wav`;

  return new Promise((resolve, reject) => {
    fileSystemManager.writeFile({
      filePath,
      data: arrayBuffer,
      success: () => resolve(filePath),
      fail: reject
    });
  });
}

function shouldIgnoreRecorderError(error) {
  const message = (error && (error.errMsg || error.message)) || "";
  return message.includes("instanceId") || message.includes("auditInstance");
}

Page({
  data: {
    id: "",
    loading: false,
    record: null,
    mimicRecord: null,
    reverseHint: "倒放版本还在处理中",
    mimicReverseHint: "模仿倒放版本还在处理中",
    playingType: "",
    currentTimeText: "00:00",
    durationText: "00:00",
    isMimicRecording: false,
    mimicSubmitting: false,
    mimicStatusText: "点击麦克风开始模仿倒放声音",
    mimicDuration: 0,
    mimicDurationText: "00:00",
    mimicTempFilePath: "",
    isMimicPreviewPlaying: false
  },

  onLoad(options) {
    detailAudio.obeyMuteSwitch = false;
    detailAudio.autoplay = false;
    previewAudio.obeyMuteSwitch = false;
    previewAudio.autoplay = false;
    this.bindDetailAudioEvents();
    this.bindPreviewAudioEvents();

    if (!options.id) {
      wx.showToast({
        title: "缺少记录编号",
        icon: "none"
      });
      return;
    }

    this.setData({
      id: options.id
    });

    this.fetchRecord();
  },

  onShow() {
    this.bindRecorderEvents();
  },

  onHide() {
    this.unbindRecorderEvents();
  },

  onUnload() {
    this.stopMimicTimer();
    this.unbindRecorderEvents();
    detailAudio.destroy();
    previewAudio.destroy();
  },

  bindRecorderEvents() {
    this.unbindRecorderEvents();

    this._onRecorderStart = () => {
      pcmFrames = [];
      this.setData({
        isMimicRecording: true,
        mimicStatusText: "录音中，请模仿你听到的倒放声音",
        mimicDuration: 0,
        mimicDurationText: "00:00",
        mimicTempFilePath: "",
        isMimicPreviewPlaying: false
      });
      this.startMimicTimer();
    };

    this._onRecorderFrame = (res) => {
      if (this.data.isMimicRecording && res.frameBuffer) {
        pcmFrames.push(res.frameBuffer);
      }
    };

    this._onRecorderStop = async () => {
      this.stopMimicTimer();

      if (previewAudio.src) {
        previewAudio.pause();
      }

      try {
        if (!pcmFrames.length) {
          throw new Error("没有收到录音数据，请重新录制");
        }

        const pcmBuffer = concatArrayBuffers(pcmFrames);
        const wavBuffer = createWavArrayBuffer(pcmBuffer, 16000, 1, 16);
        const wavFilePath = await writeWavFile(wavBuffer);

        this.setData({
          isMimicRecording: false,
          mimicStatusText: "模仿录音完成，可以试听或生成倒放",
          mimicTempFilePath: wavFilePath,
          mimicDurationText: formatDuration(this.data.mimicDuration)
        });
      } catch (error) {
        this.setData({
          isMimicRecording: false,
          mimicStatusText: "模仿录音处理失败，请重试"
        });
        wx.showToast({
          title: error.errMsg || error.message || "录音处理失败",
          icon: "none"
        });
      }
    };

    this._onRecorderError = (error) => {
      if (shouldIgnoreRecorderError(error)) {
        console.warn("已忽略录音内部提示", error);
        return;
      }

      this.stopMimicTimer();
      this.setData({
        isMimicRecording: false,
        mimicStatusText: "模仿录音失败，请重试"
      });
      wx.showToast({
        title: error.errMsg || "录音失败",
        icon: "none"
      });
    };

    recorderManager.onStart(this._onRecorderStart);
    recorderManager.onFrameRecorded(this._onRecorderFrame);
    recorderManager.onStop(this._onRecorderStop);
    recorderManager.onError(this._onRecorderError);
  },

  unbindRecorderEvents() {
    if (this._onRecorderStart && recorderManager.offStart) {
      recorderManager.offStart(this._onRecorderStart);
    }
    if (this._onRecorderFrame && recorderManager.offFrameRecorded) {
      recorderManager.offFrameRecorded(this._onRecorderFrame);
    }
    if (this._onRecorderStop && recorderManager.offStop) {
      recorderManager.offStop(this._onRecorderStop);
    }
    if (this._onRecorderError && recorderManager.offError) {
      recorderManager.offError(this._onRecorderError);
    }
    this._onRecorderStart = null;
    this._onRecorderFrame = null;
    this._onRecorderStop = null;
    this._onRecorderError = null;
  },

  bindDetailAudioEvents() {
    detailAudio.onPlay(() => {
      const record = this.resolveCurrentPlayRecord();
      this.setData({
        durationText: record ? record.durationText : "00:00"
      });
    });

    detailAudio.onTimeUpdate(() => {
      const durationMs = (detailAudio.duration || 0) * 1000;
      const record = this.resolveCurrentPlayRecord();
      this.setData({
        currentTimeText: formatDuration((detailAudio.currentTime || 0) * 1000),
        durationText: durationMs ? formatDuration(durationMs) : (record ? record.durationText : "00:00")
      });
    });

    detailAudio.onEnded(() => {
      this.resetPlayerState();
    });

    detailAudio.onPause(() => {
      this.setData({
        playingType: ""
      });
    });

    detailAudio.onStop(() => {
      this.resetPlayerState();
    });

    detailAudio.onError((error) => {
      this.resetPlayerState();
      wx.showToast({
        title: error.errMsg || "播放失败",
        icon: "none"
      });
    });
  },

  bindPreviewAudioEvents() {
    previewAudio.onPlay(() => {
      this.setData({
        isMimicPreviewPlaying: true
      });
    });

    previewAudio.onEnded(() => {
      this.setData({
        isMimicPreviewPlaying: false
      });
    });

    previewAudio.onPause(() => {
      this.setData({
        isMimicPreviewPlaying: false
      });
    });

    previewAudio.onStop(() => {
      this.setData({
        isMimicPreviewPlaying: false
      });
    });

    previewAudio.onError((error) => {
      this.setData({
        isMimicPreviewPlaying: false
      });
      wx.showToast({
        title: error.errMsg || "试听失败",
        icon: "none"
      });
    });
  },

  resolveCurrentPlayRecord() {
    const { playingType, record, mimicRecord } = this.data;
    if (playingType.startsWith("mimic") && mimicRecord) {
      return mimicRecord;
    }
    return record;
  },

  resetPlayerState() {
    const record = this.resolveCurrentPlayRecord();
    this.setData({
      playingType: "",
      currentTimeText: "00:00",
      durationText: record ? record.durationText : "00:00"
    });
  },

  startMimicTimer() {
    this.stopMimicTimer();
    mimicTimer = setInterval(() => {
      const mimicDuration = this.data.mimicDuration + 1000;
      this.setData({
        mimicDuration,
        mimicDurationText: formatDuration(mimicDuration)
      });
    }, 1000);
  },

  stopMimicTimer() {
    if (mimicTimer) {
      clearInterval(mimicTimer);
      mimicTimer = null;
    }
  },

  async fetchRecord() {
    if (this.data.loading) {
      return;
    }

    this.setData({
      loading: true
    });

    wx.showLoading({
      title: "加载中",
      mask: true
    });

    try {
      const result = await callFunction("getRecordDetail", {
        id: this.data.id
      });

      const record = result.record;
      const mimicRecord = result.mimicRecord || null;
      const reverseHintMap = {
        processing: "倒放版本还在处理中",
        done: "",
        failed: "倒放版本生成失败，请重新录音再试"
      };
      const mimicReverseHintMap = {
        processing: "模仿倒放版本还在处理中",
        done: "",
        failed: "模仿倒放版本生成失败，请重新录音再试"
      };

      this.setData({
        loading: false,
        record: {
          ...record,
          durationText: formatDuration(record.duration)
        },
        mimicRecord: mimicRecord
          ? {
            ...mimicRecord,
            durationText: formatDuration(mimicRecord.duration)
          }
          : null,
        reverseHint: reverseHintMap[record.status] || "暂时无法获取结果",
        mimicReverseHint: mimicRecord ? (mimicReverseHintMap[mimicRecord.status] || "暂时无法获取结果") : "模仿倒放版本还在处理中",
        currentTimeText: "00:00",
        durationText: formatDuration(record.duration)
      });
    } catch (error) {
      this.setData({
        loading: false
      });
      wx.showToast({
        title: error.message || "加载失败",
        icon: "none"
      });
    } finally {
      wx.hideLoading();
    }
  },

  playOriginal() {
    const { record, playingType } = this.data;
    if (!record || !record.originalTempUrl) {
      wx.showToast({
        title: "原音暂不可播放",
        icon: "none"
      });
      return;
    }

    if (playingType === "original") {
      detailAudio.pause();
      return;
    }

    detailAudio.src = record.originalTempUrl;
    detailAudio.play();
    this.setData({
      playingType: "original"
    });
  },

  playReverse() {
    const { record, playingType } = this.data;
    if (!record || record.status !== "done" || !record.reversedTempUrl) {
      wx.showToast({
        title: this.data.reverseHint || "倒放版本暂不可播放",
        icon: "none"
      });
      return;
    }

    if (playingType === "reverse") {
      detailAudio.pause();
      return;
    }

    detailAudio.src = record.reversedTempUrl;
    detailAudio.play();
    this.setData({
      playingType: "reverse"
    });
  },

  startMimicRecording() {
    if (this.data.isMimicRecording || this.data.mimicSubmitting) {
      return;
    }

    wx.authorize({
      scope: "scope.record",
      success: () => {
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
          mimicStatusText: "需要录音权限才能继续"
        });
        wx.showModal({
          title: "需要录音权限",
          content: "请在设置里允许小程序访问麦克风。",
          showCancel: false
        });
      }
    });
  },

  stopMimicRecording() {
    if (!this.data.isMimicRecording) {
      return;
    }
    recorderManager.stop();
  },

  playMimicPreview() {
    if (!this.data.mimicTempFilePath) {
      wx.showToast({
        title: "请先录音",
        icon: "none"
      });
      return;
    }

    if (this.data.isMimicPreviewPlaying) {
      previewAudio.pause();
      return;
    }

    previewAudio.src = this.data.mimicTempFilePath;
    previewAudio.play();
  },

  async submitMimicAudio() {
    if (!this.data.mimicTempFilePath || this.data.mimicSubmitting) {
      wx.showToast({
        title: this.data.mimicTempFilePath ? "生成中" : "请先录音",
        icon: "none"
      });
      return;
    }

    this.setData({
      mimicSubmitting: true,
      mimicStatusText: "正在生成模仿倒放版本"
    });

    wx.showLoading({
      title: "生成中",
      mask: true
    });

    try {
      const uploadRes = await uploadAudio(this.data.mimicTempFilePath);
      await callFunction("processAudio", {
        originalFileID: uploadRes.fileID,
        duration: this.data.mimicDuration,
        parentRecordId: this.data.id,
        sourceType: "mimic"
      });

      await this.fetchRecord();

      this.setData({
        mimicSubmitting: false,
        mimicStatusText: "模仿原音和倒放版本已生成",
        mimicTempFilePath: ""
      });
    } catch (error) {
      this.setData({
        mimicSubmitting: false,
        mimicStatusText: "生成失败，请稍后重试"
      });
      wx.showToast({
        title: error.message || "提交失败",
        icon: "none"
      });
    } finally {
      wx.hideLoading();
    }
  },

  playMimicOriginal() {
    const { mimicRecord, playingType } = this.data;
    if (!mimicRecord || !mimicRecord.originalTempUrl) {
      wx.showToast({
        title: "模仿原音暂不可播放",
        icon: "none"
      });
      return;
    }

    if (playingType === "mimicOriginal") {
      detailAudio.pause();
      return;
    }

    detailAudio.src = mimicRecord.originalTempUrl;
    detailAudio.play();
    this.setData({
      playingType: "mimicOriginal"
    });
  },

  playMimicReverse() {
    const { mimicRecord, playingType } = this.data;
    if (!mimicRecord || mimicRecord.status !== "done" || !mimicRecord.reversedTempUrl) {
      wx.showToast({
        title: this.data.mimicReverseHint || "模仿倒放版本暂不可播放",
        icon: "none"
      });
      return;
    }

    if (playingType === "mimicReverse") {
      detailAudio.pause();
      return;
    }

    detailAudio.src = mimicRecord.reversedTempUrl;
    detailAudio.play();
    this.setData({
      playingType: "mimicReverse"
    });
  },

  goHistory() {
    wx.navigateTo({
      url: "/pages/history/history"
    });
  }
});
