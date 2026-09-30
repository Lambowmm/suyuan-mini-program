const procurement = require('../../utils/procurement');

Page({
  data: {
    loading: false,
    isApproved: false,
    hospitalName: '',
    authNoticeTitle: '采购权限未开通',
    authNoticeDesc: '耗材采购仅向已认证准入的医院合作客户开放。请在“我的”页面绑定微信与手机号，并提交准入申请。',
    authNoticeBtnText: '前往申请准入',
    keyword: '',
    categories: [],
    selectedCategory: '',
    materials: [],
    cartCount: 0
  },

  onShow: function() {
    this.checkAuthAndLoad();
    this.updateCartCount();
  },

  onPullDownRefresh: function() {
    this.checkAuthAndLoad().then(function() {
      wx.stopPullDownRefresh();
    });
  },

  checkAuthAndLoad: function() {
    var self = this;
    self.setData({ loading: true });

    return procurement.request('proc_profile')
      .then(function(res) {
        if (res.status === 1 && res.user) {
          procurement.setUserInfo(res.user);
          var user = res.user;

          if (user.approvalStatus === 'APPROVED' && user.customerId) {
            self.setData({
              isApproved: true,
              hospitalName: user.customerName || '已认证医院'
            });
            return self.loadCatalog();
          } else if (user.approvalStatus === 'PENDING') {
            self.setData({
              isApproved: false,
              authNoticeTitle: '采购资质审核中',
              authNoticeDesc: '您的医院采购员准入申请正在由后台管理员审核中，审核通过后即可选购准入耗材。',
              authNoticeBtnText: '查看申请状态'
            });
          } else if (user.approvalStatus === 'REJECTED') {
            self.setData({
              isApproved: false,
              authNoticeTitle: '申请已被驳回',
              authNoticeDesc: '驳回原因：' + (user.rejectReason || '未提供具体原因') + '。您可以修改信息后重新提交申请。',
              authNoticeBtnText: '重新提交申请'
            });
          } else if (user.approvalStatus === 'DISABLED') {
            self.setData({
              isApproved: false,
              authNoticeTitle: '采购权限已停用',
              authNoticeDesc: '您的账号或所属医院客户采购权限已被停用，如有疑问请联系管理员。',
              authNoticeBtnText: '查看我的信息'
            });
          } else {
            self.setData({
              isApproved: false,
              authNoticeTitle: '尚未提交准入申请',
              authNoticeDesc: '耗材采购受资质准入保护，请先绑定手机号并提交所属医院采购申请。',
              authNoticeBtnText: '立即申请准入'
            });
          }
        } else {
          self.setData({
            isApproved: false,
            authNoticeTitle: '请先登录系统',
            authNoticeDesc: '点击下方按钮一键完成微信身份授权登录。',
            authNoticeBtnText: '前往我的登录'
          });
        }
      })
      .catch(function() {
        self.setData({
          isApproved: false,
          authNoticeTitle: '请先登录系统',
          authNoticeDesc: '需要授权微信身份以访问受保护的耗材采购目录。',
          authNoticeBtnText: '前往我的'
        });
      })
      .finally(function() {
        self.setData({ loading: false });
      });
  },

  loadCatalog: function() {
    var self = this;
    return procurement.request('proc_catalog', {
      keyword: self.data.keyword,
      category: self.data.selectedCategory
    })
      .then(function(res) {
        if (res.status === 1) {
          var list = res.list || [];
          list.forEach(function(m) {
            m.selectedUnitIndex = 0;
            m.cartQuantity = 1;
          });
          self.setData({
            materials: list,
            categories: res.categories || self.data.categories || []
          });
        } else {
          wx.showToast({ title: res.msg || '加载目录失败', icon: 'none' });
        }
      });
  },

  onSelectCategory: function(e) {
    var cat = e.currentTarget.dataset.cat;
    this.setData({ selectedCategory: cat });
    this.loadCatalog();
  },

  onSearchInput: function(e) {
    this.setData({ keyword: e.detail.value });
  },

  onSearchConfirm: function() {
    this.loadCatalog();
  },

  selectUnit: function(e) {
    var mid = e.currentTarget.dataset.mid;
    var uidx = e.currentTarget.dataset.uidx;
    var materials = this.data.materials;
    for (var i = 0; i < materials.length; i++) {
      if (materials[i].id === mid) {
        materials[i].selectedUnitIndex = uidx;
        break;
      }
    }
    this.setData({ materials: materials });
  },

  onStepperMinus: function(e) {
    var mid = e.currentTarget.dataset.id;
    var materials = this.data.materials;
    for (var i = 0; i < materials.length; i++) {
      if (materials[i].id === mid) {
        var q = (materials[i].cartQuantity || 1) - 1;
        if (q < 1) q = 1;
        materials[i].cartQuantity = q;
        break;
      }
    }
    this.setData({ materials: materials });
  },

  onStepperPlus: function(e) {
    var mid = e.currentTarget.dataset.id;
    var materials = this.data.materials;
    for (var i = 0; i < materials.length; i++) {
      if (materials[i].id === mid) {
        var mat = materials[i];
        var curUnit = (mat.units && mat.units[mat.selectedUnitIndex]) || {};
        var isGift = curUnit.isGift === true;
        var isExceeded = isGift ? curUnit.isQuotaExceeded : mat.isQuotaExceeded;
        var rem = isGift ? curUnit.remainingQuota : mat.remainingQuota;
        var qUnit = isGift ? (curUnit.quotaUnit || '') : (mat.quotaUnit || '');

        if (isExceeded) {
          wx.showToast({ title: isGift ? '已达赠品申领上限' : '已达本院限购上限', icon: 'none' });
          return;
        }
        var q = (mat.cartQuantity || 1) + 1;
        if (rem > 0 && q > rem) {
          wx.showToast({
            title: '超出剩余配额 (最多' + rem + qUnit + ')',
            icon: 'none'
          });
          return;
        }
        mat.cartQuantity = q;
        break;
      }
    }
    this.setData({ materials: materials });
  },

  onStepperBlur: function(e) {
    var mid = e.currentTarget.dataset.id;
    var val = parseInt(e.detail.value, 10);
    if (isNaN(val) || val < 1) val = 1;
    var materials = this.data.materials;
    for (var i = 0; i < materials.length; i++) {
      if (materials[i].id === mid) {
        var mat = materials[i];
        var curUnit = (mat.units && mat.units[mat.selectedUnitIndex]) || {};
        var isGift = curUnit.isGift === true;
        var rem = isGift ? curUnit.remainingQuota : mat.remainingQuota;
        var qUnit = isGift ? (curUnit.quotaUnit || '') : (mat.quotaUnit || '');

        if (rem > 0 && val > rem) {
          val = rem;
          wx.showToast({
            title: '已按最大剩余配额调整为' + val + qUnit,
            icon: 'none'
          });
        }
        mat.cartQuantity = val;
        break;
      }
    }
    this.setData({ materials: materials });
  },

  preventBubble: function() {},

  addToCart: function(e) {
    var item = e.currentTarget.dataset.item;
    var selectedUnit = item.units[item.selectedUnitIndex];
    var isGift = selectedUnit && selectedUnit.isGift === true;
    var isExceeded = isGift ? selectedUnit.isQuotaExceeded : item.isQuotaExceeded;
    var rem = isGift ? selectedUnit.remainingQuota : item.remainingQuota;
    var qUnit = isGift ? (selectedUnit.quotaUnit || '') : (item.quotaUnit || '');

    if (isExceeded) {
      wx.showToast({ title: isGift ? '该赠品已达申领上限' : '该商品已达本院限购上限', icon: 'none' });
      return;
    }

    var qty = item.cartQuantity || 1;

    if (rem > 0) {
      var cart = procurement.getCart();
      var inCartQty = 0;
      cart.forEach(function(c) {
        if (c.materialId === item.id) {
          if (isGift && c.selectedUnit === selectedUnit.unitName) {
            inCartQty += c.selectedQty;
          } else if (!isGift && !c.selectedUnit.endsWith('（赠品）')) {
            inCartQty += c.selectedQty;
          }
        }
      });
      if (inCartQty + qty > rem) {
        wx.showToast({
          title: '清单已有' + inCartQty + '，超出剩余配额(' + rem + qUnit + ')',
          icon: 'none',
          duration: 2500
        });
        return;
      }
    }

    procurement.addToCart({
      materialId: item.id,
      materialCode: item.materialCode,
      materialName: item.materialName,
      spec: item.spec,
      model: item.model,
      baseUnit: item.baseUnit,
      selectedUnit: selectedUnit.unitName,
      factorToBase: selectedUnit.factorToBase,
      packageUnitPrice: selectedUnit.packageUnitPrice,
      selectedQty: qty
    });

    this.updateCartCount();
    wx.showToast({ title: '已加入订购清单 (' + qty + selectedUnit.unitName + ')', icon: 'success' });
  },

  updateCartCount: function() {
    var cart = procurement.getCart();
    var count = 0;
    cart.forEach(function(c) {
      count += c.selectedQty;
    });
    this.setData({ cartCount: count });
  },

  goToDetail: function(e) {
    var id = e.currentTarget.dataset.id;
    wx.navigateTo({
      url: '/pages/order/detail?id=' + id
    });
  },

  goToCart: function() {
    wx.navigateTo({
      url: '/pages/order/cart'
    });
  },

  goToApply: function() {
    wx.switchTab({
      url: '/pages/mine/index'
    });
  },

  goToOrderList: function() {
    wx.navigateTo({
      url: '/pages/order/list'
    });
  }
});
