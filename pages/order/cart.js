const procurement = require('../../utils/procurement');

Page({
  data: {
    items: [], totalAmount: '0.00', totalQty: 0, hasChanges: false,
    loading: false, validationStatus: 'idle', validationMessage: '',
    hasQuotaExceeded: false, canCheckout: false
  },

  onShow: function() { this.loadAndValidateCart(); },

  onProcurementIdentityChanged: function() {
    this._validationSeq = (this._validationSeq || 0) + 1;
    this.loadAndValidateCart();
  },

  loadAndValidateCart: function() {
    var rawItems = procurement.getCart();
    var context = procurement.getCartContext();
    var seq = (this._validationSeq || 0) + 1;
    this._validationSeq = seq;
    if (!rawItems.length) {
      this.setData({ items: [], totalAmount: '0.00', totalQty: 0, hasChanges: false,
        loading: false, validationStatus: 'idle', validationMessage: '', hasQuotaExceeded: false, canCheckout: false });
      return Promise.resolve(false);
    }

    var self = this;
    var localQty = rawItems.reduce(function(sum, item) { return sum + (Number(item.selectedQty) || 0); }, 0);
    self.setData({ items: rawItems, totalAmount: '--', totalQty: localQty, loading: true, validationStatus: 'loading',
      validationMessage: '正在向服务器核验最新准入、配额与价格…', canCheckout: false });
    var payload = rawItems.map(function(item) {
      return { materialId: item.materialId, selectedUnit: item.selectedUnit, selectedQty: item.selectedQty };
    });

    return procurement.request('proc_cart_validate', { items: JSON.stringify(payload) })
      .then(function(res) {
        if (seq !== self._validationSeq || !procurement.isCartContextCurrent(context)) return false;
        if (res.status !== 1) {
          self.setData({ loading: false, validationStatus: 'error',
            validationMessage: res.msg || '服务器未能核验订购清单，请重试', canCheckout: false });
          return false;
        }
        var originalByKey = {};
        rawItems.forEach(function(item) { originalByKey[item.lineKey] = item; });
        var totalQty = 0;
        var hasQuotaExceeded = false;
        var syncCart = (res.items || []).map(function(v) {
          var key = procurement.lineKey(v.materialId, v.selectedUnit);
          var previous = originalByKey[key] || {};
          totalQty += Number(v.selectedQty) || 0;
          hasQuotaExceeded = hasQuotaExceeded || !!v.isQuotaExceeded;
          return Object.assign({}, previous, v, {
            lineKey: key,
            packageUnitPrice: Number(v.packageUnitPrice || 0).toFixed(2),
            lineAmount: Number(v.lineAmount || 0).toFixed(2)
          });
        });
        if (procurement.saveCart(syncCart, context) === null) return false;
        self._validatedContext = procurement.getCartContext();
        self.setData({
          items: syncCart, totalAmount: Number(res.totalAmount || 0).toFixed(2), totalQty: totalQty,
          hasChanges: !!res.hasChanges, loading: false, validationStatus: 'valid',
          validationMessage: hasQuotaExceeded ? '清单中有商品超出可用配额，请调整数量后重试' : '价格、准入与配额已通过服务器核验',
          hasQuotaExceeded: hasQuotaExceeded, canCheckout: syncCart.length > 0 && !hasQuotaExceeded
        });
        if (res.hasChanges) wx.showToast({ title: '部分耗材单位或价格已依据最新协议更新', icon: 'none', duration: 2500 });
        return !hasQuotaExceeded;
      })
      .catch(function(err) {
        if (seq !== self._validationSeq || !procurement.isCartContextCurrent(context)) return false;
        self.setData({ loading: false, validationStatus: 'error',
          validationMessage: (err && err.message) || '网络异常，无法核验清单；请重试', canCheckout: false });
        return false;
      });
  },

  retryValidation: function() { this.loadAndValidateCart(); },

  changeQty: function(mid, unit, qty) {
    procurement.updateCartQty(mid, unit, qty);
    this.setData({ validationStatus: 'loading', validationMessage: '数量已变更，正在重新核验…', canCheckout: false });
    return this.loadAndValidateCart();
  },

  increaseQty: function(e) {
    var mid = e.currentTarget.dataset.mid, unit = e.currentTarget.dataset.unit;
    var item = this.data.items.find(function(x) { return x.materialId === mid && x.selectedUnit === unit; });
    if (item) this.changeQty(mid, unit, Number(item.selectedQty) + 1);
  },

  decreaseQty: function(e) {
    var mid = e.currentTarget.dataset.mid, unit = e.currentTarget.dataset.unit;
    var item = this.data.items.find(function(x) { return x.materialId === mid && x.selectedUnit === unit; });
    if (item && item.selectedQty > 1) this.changeQty(mid, unit, Number(item.selectedQty) - 1);
  },

  onQtyBlur: function(e) {
    var val = parseInt(e.detail.value, 10);
    if (isNaN(val) || val < 1) val = 1;
    this.changeQty(e.currentTarget.dataset.mid, e.currentTarget.dataset.unit, val);
  },

  removeItem: function(e) {
    var mid = e.currentTarget.dataset.mid, unit = e.currentTarget.dataset.unit, self = this;
    var modalContext = procurement.getCartContext();
    wx.showModal({ title: '确认删除', content: '是否从订购清单中移除该耗材？', success: function(sm) {
      if (sm.confirm && procurement.isCartContextCurrent(modalContext)) self.changeQty(mid, unit, 0);
    }});
  },

  goToCatalog: function() {
    wx.switchTab({ url: '/pages/order/index', fail: function() { wx.navigateTo({ url: '/pages/order/index' }); } });
  },

  goToCheckout: function() {
    if (!this.data.items.length) { wx.showToast({ title: '清单为空', icon: 'none' }); return; }
    if (!this.data.canCheckout || this.data.loading || this.data.validationStatus !== 'valid') {
      wx.showToast({ title: this.data.hasQuotaExceeded ? '请先调整超出配额的数量' : '请先完成清单核验', icon: 'none' });
      return;
    }
    if (!procurement.isCartContextCurrent(this._validatedContext)) {
      this.setData({ canCheckout: false, validationStatus: 'error', validationMessage: '登录身份或清单已变化，请重新核验' });
      return;
    }
    wx.navigateTo({ url: '/pages/order/checkout' });
  }
});
