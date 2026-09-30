const procurement = require('../../utils/procurement');

Page({
  data: {
    items: [],
    totalAmount: '0.00',
    totalQty: 0,
    hasChanges: false,
    loading: false
  },

  onShow: function() {
    this.loadAndValidateCart();
  },

  loadAndValidateCart: function() {
    var rawItems = procurement.getCart();
    if (!rawItems || rawItems.length === 0) {
      this.setData({
        items: [],
        totalAmount: '0.00',
        totalQty: 0,
        hasChanges: false
      });
      return;
    }

    var self = this;
    self.setData({ loading: true });

    var payload = rawItems.map(function(item) {
      return {
        materialId: item.materialId,
        selectedUnit: item.selectedUnit,
        selectedQty: item.selectedQty
      };
    });

    procurement.request('proc_cart_validate', { items: JSON.stringify(payload) })
      .then(function(res) {
        if (res.status === 1) {
          var validatedItems = res.items || [];
          var totalQty = 0;
          var syncCart = [];

          validatedItems.forEach(function(v) {
            totalQty += v.selectedQty;
            syncCart.push({
              materialId: v.materialId,
              materialCode: v.materialCode,
              materialName: v.materialName,
              selectedUnit: v.selectedUnit,
              factorToBase: v.factorToBase,
              packageUnitPrice: v.packageUnitPrice,
              selectedQty: v.selectedQty,
              lineAmount: Number(v.lineAmount).toFixed(2),
              ruleDescription: v.ruleDescription
            });
          });

          procurement.saveCart(syncCart);

          self.setData({
            items: syncCart,
            totalAmount: Number(res.totalAmount || 0).toFixed(2),
            totalQty: totalQty,
            hasChanges: !!res.hasChanges
          });

          if (res.hasChanges) {
            wx.showToast({
              title: '部分耗材单位或价格已依据最新协议更新',
              icon: 'none',
              duration: 2500
            });
          }
        } else {
          wx.showToast({ title: res.msg || '校验清单失败', icon: 'none' });
        }
      })
      .catch(function() {
        // Fallback to local calculation if network fails
        var total = 0;
        var totalQty = 0;
        rawItems.forEach(function(c) {
          var price = Number(c.packageUnitPrice) || 0;
          var line = price * c.selectedQty;
          c.lineAmount = line.toFixed(2);
          total += line;
          totalQty += c.selectedQty;
        });
        self.setData({
          items: rawItems,
          totalAmount: total.toFixed(2),
          totalQty: totalQty
        });
      })
      .finally(function() {
        self.setData({ loading: false });
      });
  },

  increaseQty: function(e) {
    var mid = e.currentTarget.dataset.mid;
    var unit = e.currentTarget.dataset.unit;
    var items = this.data.items;

    for (var i = 0; i < items.length; i++) {
      if (items[i].materialId === mid && items[i].selectedUnit === unit) {
        var newQty = items[i].selectedQty + 1;
        procurement.updateCartQty(mid, unit, newQty);
        break;
      }
    }
    this.loadAndValidateCart();
  },

  decreaseQty: function(e) {
    var mid = e.currentTarget.dataset.mid;
    var unit = e.currentTarget.dataset.unit;
    var items = this.data.items;

    for (var i = 0; i < items.length; i++) {
      if (items[i].materialId === mid && items[i].selectedUnit === unit) {
        if (items[i].selectedQty > 1) {
          var newQty = items[i].selectedQty - 1;
          procurement.updateCartQty(mid, unit, newQty);
          this.loadAndValidateCart();
        }
        break;
      }
    }
  },

  onQtyBlur: function(e) {
    var mid = e.currentTarget.dataset.mid;
    var unit = e.currentTarget.dataset.unit;
    var val = parseInt(e.detail.value, 10);
    if (isNaN(val) || val < 1) {
      val = 1;
    }
    procurement.updateCartQty(mid, unit, val);
    this.loadAndValidateCart();
  },

  removeItem: function(e) {
    var mid = e.currentTarget.dataset.mid;
    var unit = e.currentTarget.dataset.unit;
    var self = this;

    wx.showModal({
      title: '确认删除',
      content: '是否从订购清单中移除该耗材？',
      success: function(sm) {
        if (sm.confirm) {
          procurement.updateCartQty(mid, unit, 0);
          self.loadAndValidateCart();
        }
      }
    });
  },

  goToCatalog: function() {
    wx.switchTab({
      url: '/pages/order/index',
      fail: function() {
        wx.navigateTo({ url: '/pages/order/index' });
      }
    });
  },

  goToCheckout: function() {
    if (this.data.items.length === 0) {
      wx.showToast({ title: '清单为空', icon: 'none' });
      return;
    }
    wx.navigateTo({
      url: '/pages/order/checkout'
    });
  }
});
