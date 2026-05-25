const { callFunction } = require("../../utils/cloud");

function formatDuration(ms) {
  const totalSeconds = Math.floor((ms || 0) / 1000);
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function formatDate(dateStr) {
  const date = new Date(dateStr);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${month}-${day} ${hour}:${minute}`;
}

Page({
  data: {
    records: [],
    deletingId: "",
    fetching: false
  },

  onShow() {
    this.fetchRecords();
  },

  async fetchRecords() {
    if (this.data.fetching) {
      return;
    }

    this.setData({
      fetching: true
    });

    wx.showNavigationBarLoading();
    wx.showLoading({
      title: "加载中",
      mask: true
    });

    try {
      const result = await callFunction("getRecords");
      const statusTextMap = {
        processing: "处理中",
        done: "已完成",
        failed: "失败"
      };

      const records = (result.records || []).map((item) => ({
        ...item,
        durationText: formatDuration(item.duration),
        createdAtText: formatDate(item.createdAt),
        statusText: statusTextMap[item.status] || "未知"
      }));

      this.setData({
        records
      });
    } catch (error) {
      wx.showToast({
        title: error.message || "加载失败",
        icon: "none"
      });
    } finally {
      wx.hideLoading();
      wx.hideNavigationBarLoading();
      this.setData({
        fetching: false
      });
    }
  },

  goDetail(event) {
    const { id } = event.currentTarget.dataset;
    wx.navigateTo({
      url: `/pages/detail/detail?id=${id}`
    });
  },

  deleteRecord(event) {
    const { id } = event.currentTarget.dataset;

    if (this.data.deletingId) {
      return;
    }

    wx.showModal({
      title: "删除记录",
      content: "删除后不可恢复，确定删除吗？",
      success: async ({ confirm }) => {
        if (!confirm) {
          return;
        }

        this.setData({
          deletingId: id
        });

        wx.showLoading({
          title: "删除中",
          mask: true
        });

        try {
          await callFunction("deleteRecord", { id });
          wx.showToast({
            title: "已删除",
            icon: "success"
          });
          await this.fetchRecords();
        } catch (error) {
          wx.showToast({
            title: error.message || "删除失败",
            icon: "none"
          });
        } finally {
          wx.hideLoading();
          this.setData({
            deletingId: ""
          });
        }
      }
    });
  }
});
