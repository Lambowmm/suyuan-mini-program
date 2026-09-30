Page({
  data: {},

  onLoad: function() {},

  goToReport: function() {
    wx.switchTab({
      url: '/pages/report/index'
    });
  },

  goToOrder: function() {
    wx.switchTab({
      url: '/pages/order/index'
    });
  }
});
