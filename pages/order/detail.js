const procurement = require('../../utils/procurement');
const config = require('../../utils/config');

Page({
  data: {
    materialId: 0,
    detail: null,
    selectedUnitIndex: 0,
    cartCount: 0
  },

  onLoad: function(options) {
    var id = parseInt(options.id, 10);
    if (id > 0) {
      this.setData({ materialId: id });
      this.loadDetail(id);
    } else {
      wx.showToast({ title: '参数错误', icon: 'none' });
    }
  },

  onShow: function() {
    this.updateCartCount();
  },

  loadDetail: function(id) {
    var self = this;
    wx.showLoading({ title: '加载中...' });
    procurement.request('proc_material_detail', { materialId: id })
      .then(function(res) {
        wx.hideLoading();
        if (res.status === 1 && res.detail) {
          self.setData({
            detail: res.detail,
            selectedUnitIndex: 0
          });
        } else {
          wx.showToast({ title: res.msg || '加载详情失败', icon: 'none' });
        }
      })
      .catch(function() {
        wx.hideLoading();
        wx.showToast({ title: '网络异常', icon: 'none' });
      });
  },

  selectUnit: function(e) {
    var index = e.currentTarget.dataset.index;
    this.setData({ selectedUnitIndex: index });
  },

  openFile: function(e) {
    var file = e.currentTarget.dataset.file;
    if (!file || !file.id) return;

    var token = procurement.getToken();
    var downloadBase = config.API_HOST.replace('/tools/wxopen.ashx', '/tools/proc_download.ashx');
    var downloadUrl = downloadBase + '?id=' + file.id + '&token=' + encodeURIComponent(token);

    var ext = (file.fileExtension || '').toLowerCase().replace(/^\./, '');
    wx.showLoading({ title: '正在下载预览...' });

    wx.downloadFile({
      url: downloadUrl,
      success: function(res) {
        wx.hideLoading();
        if (res.statusCode === 200) {
          var tempPath = res.tempFilePath;
          if (['jpg', 'jpeg', 'png', 'gif'].indexOf(ext) >= 0) {
            wx.previewImage({
              urls: [tempPath],
              current: tempPath
            });
          } else if (['pdf', 'doc', 'docx', 'xls', 'xlsx'].indexOf(ext) >= 0) {
            wx.openDocument({
              filePath: tempPath,
              fileType: ext,
              showMenu: true,
              fail: function() {
                wx.showToast({ title: '打开文件失败或格式不支持', icon: 'none' });
              }
            });
          } else {
            wx.showToast({ title: '文件已下载', icon: 'none' });
          }
        } else {
          wx.showToast({ title: '下载失败 (' + res.statusCode + ')', icon: 'none' });
        }
      },
      fail: function() {
        wx.hideLoading();
        wx.showToast({ title: '文件下载失败，请检查网络', icon: 'none' });
      }
    });
  },

  addToCart: function() {
    var detail = this.data.detail;
    if (!detail || !detail.units || detail.units.length === 0) return;

    var selectedUnit = detail.units[this.data.selectedUnitIndex];
    if (!selectedUnit) return;

    var isGift = selectedUnit.isGift === true;
    var isExceeded = isGift ? selectedUnit.isQuotaExceeded : detail.isQuotaExceeded;
    var rem = isGift ? selectedUnit.remainingQuota : detail.remainingQuota;
    var qUnit = isGift ? (selectedUnit.quotaUnit || '') : (detail.quotaUnit || '');

    if (isExceeded) {
      wx.showToast({ title: isGift ? '该赠品已达申领上限' : '该商品已达本院限购上限', icon: 'none' });
      return;
    }

    if (rem > 0) {
      var cart = procurement.getCart();
      var inCartQty = 0;
      cart.forEach(function(c) {
        if (c.materialId === detail.id) {
          if (isGift && c.selectedUnit === selectedUnit.unitName) {
            inCartQty += c.selectedQty;
          } else if (!isGift && !c.selectedUnit.endsWith('（赠品）')) {
            inCartQty += c.selectedQty;
          }
        }
      });
      if (inCartQty + 1 > rem) {
        wx.showToast({
          title: '清单已有' + inCartQty + '，超出剩余配额(' + rem + qUnit + ')',
          icon: 'none',
          duration: 2500
        });
        return;
      }
    }

    procurement.addToCart({
      materialId: detail.id,
      materialCode: detail.materialCode,
      materialName: detail.materialName,
      spec: detail.spec,
      model: detail.model,
      baseUnit: detail.baseUnit,
      selectedUnit: selectedUnit.unitName,
      factorToBase: selectedUnit.factorToBase,
      packageUnitPrice: selectedUnit.packageUnitPrice,
      selectedQty: 1
    });

    this.updateCartCount();
    wx.showToast({ title: '已加入订购清单', icon: 'success' });
  },

  updateCartCount: function() {
    var cart = procurement.getCart();
    var count = 0;
    cart.forEach(function(c) {
      count += c.selectedQty;
    });
    this.setData({ cartCount: count });
  },

  goToCart: function() {
    wx.navigateTo({
      url: '/pages/order/cart'
    });
  }
});
