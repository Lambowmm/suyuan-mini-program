const procurement = require('../../utils/procurement');
const config = require('../../utils/config');

Page({
  data: {
    settlements: [],
    loading: false,
    expandedId: 0
  },

  onShow: function() {
    this.loadSettlements();
  },

  onPullDownRefresh: function() {
    var self = this;
    this.loadSettlements().then(function() {
      wx.stopPullDownRefresh();
    });
  },

  loadSettlements: function() {
    var self = this;
    self.setData({ loading: true });

    return procurement.request('proc_settlement_list')
      .then(function(res) {
        if (res.status === 1) {
          var list = res.list || [];
          list.forEach(function(s) {
            s.totalAmount = Number(s.totalAmount).toFixed(2);
            s.items = null;
          });
          self.setData({ settlements: list });
        } else {
          wx.showToast({ title: res.msg || '加载结算单失败', icon: 'none' });
        }
      })
      .catch(function() {
        wx.showToast({ title: '网络异常', icon: 'none' });
      })
      .finally(function() {
        self.setData({ loading: false });
      });
  },

  toggleDetail: function(e) {
    var id = e.currentTarget.dataset.id;
    if (this.data.expandedId === id) {
      this.setData({ expandedId: 0 });
      return;
    }

    this.setData({ expandedId: id });
    this.loadDetail(id);
  },

  loadDetail: function(id) {
    var self = this;
    wx.showLoading({ title: '加载结算明细...' });

    procurement.request('proc_settlement_detail', { id: id })
      .then(function(res) {
        wx.hideLoading();
        if (res.status === 1 && res.settlement) {
          var items = res.settlement.items || [];
          items.forEach(function(it) {
            it.postedAmount = Number(it.postedAmount).toFixed(2);
          });

          var settlements = self.data.settlements;
          for (var i = 0; i < settlements.length; i++) {
            if (settlements[i].id === id) {
              settlements[i].items = items;
              break;
            }
          }
          self.setData({ settlements: settlements });
        } else {
          wx.showToast({ title: res.msg || '加载明细失败', icon: 'none' });
        }
      })
      .catch(function() {
        wx.hideLoading();
        wx.showToast({ title: '网络异常', icon: 'none' });
      });
  },

  exportExcel: function(e) {
    var id = e.currentTarget.dataset.id;
    var token = procurement.getToken();
    var downloadUrl = config.API_HOST + '?action=proc_export_settlement&id=' + id + '&token=' + encodeURIComponent(token);

    wx.showLoading({ title: '正在导出Excel对账单...' });
    wx.downloadFile({
      url: downloadUrl,
      success: function(res) {
        wx.hideLoading();
        if (res.statusCode === 200) {
          wx.openDocument({
            filePath: res.tempFilePath,
            fileType: 'xlsx',
            showMenu: true,
            fail: function() {
              wx.showToast({ title: '无法打开表格或格式不支持', icon: 'none' });
            }
          });
        } else {
          wx.showToast({ title: '导出失败 (' + res.statusCode + ')', icon: 'none' });
        }
      },
      fail: function() {
        wx.hideLoading();
        wx.showToast({ title: '下载失败', icon: 'none' });
      }
    });
  }
});
