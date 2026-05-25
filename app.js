const { cloudEnvId, recordCollectionName } = require("./config/env");

App({
  globalData: {
    cloudEnvId,
    recordCollectionName
  },
  onLaunch() {
    if (!wx.cloud) {
      console.error("请使用 2.2.3 及以上基础库以支持云能力");
      return;
    }

    if (!this.globalData.cloudEnvId || this.globalData.cloudEnvId === "your-cloud-env-id") {
      console.warn("请先在 config/env.js 里配置云开发环境 ID");
    }

    wx.cloud.init({
      env: this.globalData.cloudEnvId,
      traceUser: true
    });

    if (wx.setInnerAudioOption) {
      wx.setInnerAudioOption({
        mixWithOther: false,
        obeyMuteSwitch: false
      });
    }
  }
});
