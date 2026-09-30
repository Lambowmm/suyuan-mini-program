const procurement = require('../../utils/procurement');

Page({
  data: {
    addresses: [],
    selectedAddress: null,
    items: [],
    totalAmount: '0.00',
    totalQty: 0,
    remarks: '',
    idempotencyKey: '',
    submitting: false,
    orderSubmitted: false,
    submittedOrderNo: '',
    submittedOrderId: 0,
    submittedAmount: '0.00',
    showConfirmModal: false,
    showSuccessModal: false
  },

  onLoad: function() {
    this.initIdempotencyKey();
    this.loadCartData();
    this.loadAddresses();
  },

  initIdempotencyKey: function() {
    var key = 'idemp_' + Date.now() + '_' + Math.random().toString(36).substring(2, 10);
    this.setData({ idempotencyKey: key });
  },

  loadCartData: function() {
    var cart = procurement.getCart();
    if (!cart || cart.length === 0) {
      if (!this.data.orderSubmitted) {
        wx.showToast({ title: '订购清单为空', icon: 'none' });
        setTimeout(function() {
          wx.navigateBack();
        }, 1000);
      }
      return;
    }

    var total = 0;
    var totalQty = 0;
    cart.forEach(function(c) {
      var price = Number(c.packageUnitPrice) || 0;
      var qty = c.selectedQty || 1;
      var line = price * qty;
      c.lineAmount = line.toFixed(2);
      total += line;
      totalQty += qty;
    });

    this.setData({
      items: cart,
      totalAmount: total.toFixed(2),
      totalQty: totalQty
    });
  },

  loadAddresses: function() {
    var self = this;
    procurement.request('proc_addresses')
      .then(function(res) {
        if (res.status === 1 && res.list && res.list.length > 0) {
          var list = res.list;
          var selected = list[0];
          for (var i = 0; i < list.length; i++) {
            if (list[i].isDefault) {
              selected = list[i];
              break;
            }
          }
          self.setData({
            addresses: list,
            selectedAddress: selected
          });
        }
      })
      .catch(function() {
        wx.showToast({ title: '加载收货地址失败', icon: 'none' });
      });
  },

  showAddressPicker: function() {
    var addresses = this.data.addresses;
    if (!addresses || addresses.length <= 1) return;

    var itemList = addresses.map(function(a) {
      return a.recipientName + ' (' + a.recipientPhone + ') ' + a.fullAddress;
    });

    var self = this;
    wx.showActionSheet({
      itemList: itemList,
      success: function(res) {
        var index = res.tapIndex;
        if (index >= 0 && index < addresses.length) {
          self.setData({ selectedAddress: addresses[index] });
        }
      }
    });
  },

  onRemarksInput: function(e) {
    this.setData({ remarks: e.detail.value });
  },

  submitOrder: function() {
    var self = this;
    // 防重复提交：若正在提交中或已经成功提交过，直接阻止
    if (self.data.submitting || self.data.orderSubmitted) {
      return;
    }

    var selectedAddress = self.data.selectedAddress;
    if (!selectedAddress) {
      wx.showModal({
        title: '请选择收货信息',
        content: '尚未选择医院收货地址，请先选择或联系管理员配置。',
        showCancel: false,
        confirmText: '我知道了'
      });
      return;
    }

    var items = self.data.items;
    if (!items || items.length === 0) {
      wx.showModal({
        title: '订购清单为空',
        content: '当前订购清单中暂无耗材商品，请返回耗材目录添加。',
        showCancel: false,
        confirmText: '我知道了'
      });
      return;
    }

    // 优雅自定义确认弹窗排版
    self.setData({ showConfirmModal: true });
  },

  closeConfirmModal: function() {
    if (this.data.submitting) return;
    this.setData({ showConfirmModal: false });
  },

  preventTouchMove: function() {
    // 阻止蒙层后方页面滚动
    return;
  },

  executeSubmit: function() {
    var self = this;
    if (self.data.submitting || self.data.orderSubmitted) {
      return;
    }

    var selectedAddress = self.data.selectedAddress;
    var items = self.data.items;
    var payloadItems = items.map(function(itm) {
      return {
        materialId: itm.materialId,
        selectedUnit: itm.selectedUnit,
        selectedQty: itm.selectedQty
      };
    });

    self.setData({ submitting: true });
    wx.showLoading({ title: '正在提交采购订单...', mask: true });

    procurement.request('proc_order_submit', {
      idempotencyKey: self.data.idempotencyKey,
      addressId: selectedAddress.id,
      remarks: self.data.remarks,
      items: JSON.stringify(payloadItems)
    })
      .then(function(res) {
        wx.hideLoading();

        if (res.status === 1) {
          var finalAmount = (res.totalAmount != null) ? Number(res.totalAmount).toFixed(2) : self.data.totalAmount;

          // 标记已成功提交，彻底锁死防重复提交，并展示优雅的提交成功反馈弹窗
          self.setData({
            submitting: false,
            orderSubmitted: true,
            submittedOrderNo: res.orderNo || '',
            submittedOrderId: res.orderId || 0,
            submittedAmount: finalAmount,
            showConfirmModal: false,
            showSuccessModal: true
          });

          // 清空本地已下单购物车缓存
          procurement.clearCart();
        } else {
          self.setData({ submitting: false, showConfirmModal: false });
          // 重新生成幂等标识，允许用户修改后重试
          self.initIdempotencyKey();

          // 失败时使用完整弹窗提示，不截断错误
          wx.showModal({
            title: '订单提交未完成',
            content: res.msg || '服务器处理订单异常，请稍后重试',
            showCancel: false,
            confirmText: '我知道了'
          });
        }
      })
      .catch(function(err) {
        wx.hideLoading();
        self.setData({ submitting: false, showConfirmModal: false });
        self.initIdempotencyKey();

        wx.showModal({
          title: '网络请求异常',
          content: (err && err.message) || '网络连接超时，请检查网络设置后重试',
          showCancel: false,
          confirmText: '我知道了'
        });
      });
  },

  copyOrderNo: function() {
    var orderNo = this.data.submittedOrderNo;
    if (!orderNo) return;
    wx.setClipboardData({
      data: orderNo,
      success: function() {
        wx.showToast({ title: '单号已复制', icon: 'success' });
      }
    });
  },

  goToCatalog: function() {
    wx.switchTab({
      url: '/pages/order/index'
    });
  },

  goToOrderList: function() {
    wx.redirectTo({
      url: '/pages/order/list'
    });
  }
});
