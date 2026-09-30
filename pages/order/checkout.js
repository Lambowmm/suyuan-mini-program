const procurement = require('../../utils/procurement');

Page({
  data: {
    addresses: [], selectedAddress: null, items: [], totalAmount: '0.00', totalQty: 0,
    remarks: '', idempotencyKey: '', submitting: false, orderSubmitted: false,
    submittedOrderNo: '', submittedOrderId: 0, submittedAmount: '0.00',
    showConfirmModal: false, showSuccessModal: false, validating: false,
    validationStatus: 'idle', validationMessage: '', canSubmit: false, quoteChanged: false,
    submissionUncertain: false
  },

  onLoad: function() {
    this.initIdempotencyKey();
    this.validateCart(false);
    this.loadAddresses();
  },

  onProcurementIdentityChanged: function() {
    this._validationSeq = (this._validationSeq || 0) + 1;
    this._ambiguousSubmission = null;
    this._validatedContext = null;
    this.initIdempotencyKey();
    this.setData({
      addresses: [], selectedAddress: null, items: [], totalAmount: '0.00', totalQty: 0,
      remarks: '', submitting: false, orderSubmitted: false, submittedOrderNo: '',
      submittedOrderId: 0, submittedAmount: '0.00', showConfirmModal: false,
      showSuccessModal: false, validating: false, validationStatus: 'idle',
      validationMessage: '', canSubmit: false, quoteChanged: false, submissionUncertain: false
    });
    this.validateCart(false);
    this.loadAddresses();
  },

  initIdempotencyKey: function() {
    this.setData({ idempotencyKey: 'idemp_' + Date.now() + '_' + Math.random().toString(36).substring(2, 10) });
  },

  quotesDiffer: function(previous, next, previousTotal, nextTotal) {
    if (previous.length !== next.length || Number(previousTotal).toFixed(2) !== Number(nextTotal).toFixed(2)) return true;
    var byKey = {};
    previous.forEach(function(item) { byKey[item.lineKey || procurement.lineKey(item.materialId, item.selectedUnit)] = item; });
    return next.some(function(item) {
      var old = byKey[item.lineKey];
      return !old || Number(old.selectedQty) !== Number(item.selectedQty) ||
        Number(old.factorToBase) !== Number(item.factorToBase) ||
        Number(old.packageUnitPrice).toFixed(2) !== Number(item.packageUnitPrice).toFixed(2) ||
        Number(old.lineAmount).toFixed(2) !== Number(item.lineAmount).toFixed(2);
    });
  },

  validateCart: function(showConfirmation) {
    var raw = procurement.getCart();
    var context = procurement.getCartContext();
    var seq = (this._validationSeq || 0) + 1;
    this._validationSeq = seq;
    if (!raw.length) {
      this.setData({ items: [], totalAmount: '0.00', totalQty: 0, validating: false,
        validationStatus: 'error', validationMessage: '订购清单为空', canSubmit: false, showConfirmModal: false });
      return Promise.resolve(false);
    }
    var self = this;
    self.setData({ items: raw, totalAmount: '--', validating: true, validationStatus: 'loading',
      validationMessage: '正在重新核验最新价格、单位与配额…', canSubmit: false, showConfirmModal: false });
    var payload = raw.map(function(item) { return { materialId: item.materialId, selectedUnit: item.selectedUnit, selectedQty: item.selectedQty }; });
    return procurement.request('proc_cart_validate', { items: JSON.stringify(payload) })
      .then(function(res) {
        if (seq !== self._validationSeq || !procurement.isCartContextCurrent(context)) return false;
        if (res.status !== 1) {
          self.setData({ validating: false, validationStatus: 'error', validationMessage: res.msg || '服务器核验失败，请重试', canSubmit: false });
          return false;
        }
        var oldByKey = {};
        raw.forEach(function(item) { oldByKey[item.lineKey] = item; });
        var totalQty = 0, exceeded = false;
        var validated = (res.items || []).map(function(v) {
          var key = procurement.lineKey(v.materialId, v.selectedUnit);
          totalQty += Number(v.selectedQty) || 0;
          exceeded = exceeded || !!v.isQuotaExceeded;
          return Object.assign({}, oldByKey[key] || {}, v, { lineKey: key,
            packageUnitPrice: Number(v.packageUnitPrice || 0).toFixed(2), lineAmount: Number(v.lineAmount || 0).toFixed(2) });
        });
        var changed = !!res.hasChanges || self.quotesDiffer(raw, validated, self.data.totalAmount, res.totalAmount);
        if (procurement.saveCart(validated, context) === null) return false;
        self._validatedContext = procurement.getCartContext();
        var valid = validated.length > 0 && !exceeded;
        self.setData({ items: validated, totalAmount: Number(res.totalAmount || 0).toFixed(2), totalQty: totalQty,
          validating: false, validationStatus: valid ? 'valid' : 'error', canSubmit: valid,
          quoteChanged: changed, validationMessage: exceeded ? '清单中有商品超出可用配额，请返回调整' :
            (changed ? '服务器报价或单位信息已更新，请重新核对后确认' : '当前清单已通过服务器核验') });
        if (valid && showConfirmation) self.setData({ showConfirmModal: true });
        return valid;
      })
      .catch(function(err) {
        if (seq !== self._validationSeq || !procurement.isCartContextCurrent(context)) return false;
        self.setData({ validating: false, validationStatus: 'error',
          validationMessage: (err && err.message) || '网络异常，无法核验清单；请重试', canSubmit: false });
        return false;
      });
  },

  retryValidation: function() { this.validateCart(false); },

  loadAddresses: function() {
    var self = this;
    var requestContext = procurement.getCartContext();
    procurement.request('proc_addresses').then(function(res) {
      var current = procurement.getCartContext();
      if (current.scopeKey !== requestContext.scopeKey || current.identityGeneration !== requestContext.identityGeneration) return;
      if (res.status === 1 && res.list && res.list.length) {
        var selected = res.list[0];
        for (var i = 0; i < res.list.length; i++) if (res.list[i].isDefault) { selected = res.list[i]; break; }
        self.setData({ addresses: res.list, selectedAddress: selected });
      }
    }).catch(function() { wx.showToast({ title: '加载收货地址失败', icon: 'none' }); });
  },

  abandonAmbiguousRetry: function() {
    if (!this._ambiguousSubmission) return false;
    wx.showToast({ title: '上次提交结果待确认，请先重试原订单', icon: 'none' });
    return true;
  },

  showAddressPicker: function() {
    var addresses = this.data.addresses, self = this;
    if (this.abandonAmbiguousRetry()) return;
    if (!addresses || addresses.length <= 1) return;
    var pickerContext = procurement.getCartContext();
    wx.showActionSheet({ itemList: addresses.map(function(a) { return a.recipientName + ' (' + a.recipientPhone + ') ' + a.fullAddress; }),
      success: function(res) { var current = procurement.getCartContext(); if (current.scopeKey !== pickerContext.scopeKey || current.identityGeneration !== pickerContext.identityGeneration) return;
        if (res.tapIndex >= 0 && res.tapIndex < addresses.length) {
        self.setData({ selectedAddress: addresses[res.tapIndex] });
      }} });
  },

  onRemarksInput: function(e) { if (!this.abandonAmbiguousRetry()) this.setData({ remarks: e.detail.value }); },

  submitOrder: function() {
    if (this.data.submitting || this.data.orderSubmitted) return;
    if (!this.data.selectedAddress) {
      wx.showModal({ title: '请选择收货信息', content: '尚未选择医院收货地址，请先选择或联系管理员配置。', showCancel: false });
      return;
    }
    if (this._ambiguousSubmission) {
      var pending = this._ambiguousSubmission;
      this.setData({ items: pending.items, totalAmount: pending.totalAmount, totalQty: pending.totalQty,
        selectedAddress: pending.selectedAddress, remarks: pending.remarks, canSubmit: true,
        validationStatus: 'valid', validationMessage: '正在重试上次已确认的原订单内容', showConfirmModal: true });
      return;
    }
    this.validateCart(true);
  },

  closeConfirmModal: function() { if (!this.data.submitting) this.setData({ showConfirmModal: false }); },
  preventTouchMove: function() {},

  buildSubmission: function() {
    var self = this;
    var payloadItems = self.data.items.map(function(item) {
      return { materialId: item.materialId, selectedUnit: item.selectedUnit, selectedQty: item.selectedQty,
        expectedFactorToBase: item.factorToBase, expectedPackageUnitPrice: item.packageUnitPrice,
        expectedLineAmount: item.lineAmount };
    });
    return { idempotencyKey: self.data.idempotencyKey, addressId: self.data.selectedAddress.id,
      remarks: self.data.remarks, expectedTotalAmount: self.data.totalAmount, items: JSON.stringify(payloadItems) };
  },

  executeSubmit: function() {
    var self = this;
    if (self.data.submitting || self.data.orderSubmitted || !self.data.canSubmit || self.data.validationStatus !== 'valid') return;
    var pending = self._ambiguousSubmission;
    if (!pending && !procurement.isCartContextCurrent(self._validatedContext)) {
      self.setData({ canSubmit: false, validationStatus: 'error', validationMessage: '清单已变化，请重新核验后确认' });
      return;
    }
    var submission = pending ? pending.params : self.buildSubmission();
    var submitContext = procurement.getCartContext();
    self.setData({ submitting: true });
    wx.showLoading({ title: '正在提交采购订单...', mask: true });
    procurement.request('proc_order_submit', submission).then(function(res) {
      wx.hideLoading();
      var currentContext = procurement.getCartContext();
      if (currentContext.scopeKey !== submitContext.scopeKey || currentContext.identityGeneration !== submitContext.identityGeneration) return;
      if (res.status === 1) {
        self._ambiguousSubmission = null;
        self.setData({ submitting: false, orderSubmitted: true, submittedOrderNo: res.orderNo || '', submittedOrderId: res.orderId || 0,
          submittedAmount: res.totalAmount != null ? Number(res.totalAmount).toFixed(2) : self.data.totalAmount,
          showConfirmModal: false, showSuccessModal: true, submissionUncertain: false });
        procurement.clearCart();
        return;
      }
      self._ambiguousSubmission = null;
      self.setData({ submitting: false, showConfirmModal: false, submissionUncertain: false });
      self.initIdempotencyKey();
      if (res.code === 'QUOTE_CHANGED') {
        self.setData({ canSubmit: false, validationStatus: 'error', validationMessage: res.msg || '报价已变化，请重新核对' });
        self.validateCart(false).then(function() {
          wx.showModal({ title: '报价已更新', content: (res.msg || '价格或包装换算已变化') + '。已重新加载，请核对后再次确认。', showCancel: false });
        });
      } else {
        wx.showModal({ title: '订单提交未完成', content: res.msg || '服务器处理订单异常，请稍后重试', showCancel: false });
      }
    }).catch(function(err) {
      wx.hideLoading();
      var currentContext = procurement.getCartContext();
      if (currentContext.scopeKey !== submitContext.scopeKey || currentContext.identityGeneration !== submitContext.identityGeneration) return;
      self._ambiguousSubmission = pending || { params: submission, items: self.data.items.map(function(item) { return Object.assign({}, item); }),
        totalAmount: self.data.totalAmount, totalQty: self.data.totalQty, selectedAddress: Object.assign({}, self.data.selectedAddress), remarks: self.data.remarks };
      self.setData({ submitting: false, showConfirmModal: false, submissionUncertain: true });
      wx.showModal({ title: '提交结果待确认', content: ((err && err.message) || '网络连接超时') + '。请点击“确认上次提交 / 重试原订单”，系统会使用原订单内容安全查询或继续提交。', showCancel: false });
    });
  },

  copyOrderNo: function() { var no = this.data.submittedOrderNo; if (no) wx.setClipboardData({ data: no, success: function() { wx.showToast({ title: '单号已复制', icon: 'success' }); } }); },
  goToCatalog: function() { wx.switchTab({ url: '/pages/order/index' }); },
  goToOrderList: function() { wx.redirectTo({ url: '/pages/order/list' }); }
});
