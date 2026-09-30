const procurement = require('../../utils/procurement');

Page({
  data: {
    hospitalName: '',
    realName: '',
    department: '',
    phone: '',
    submitting: false,
    isPending: false,
    isApproved: false,
    user: null,
    statusText: '认证采购'
  },

  onLoad: function() {
    var user = procurement.getUserInfo();
    var token = procurement.getToken();

    if (!token || !user) {
      wx.showModal({
        title: '未登录',
        content: '请先完成微信授权登录',
        showCancel: false,
        success: function() {
          wx.navigateBack({
            fail: function() {
              wx.switchTab({ url: '/pages/mine/index' });
            }
          });
        }
      });
      return;
    }

    // 绑定手机号才能申请采购准入
    if (!user.phone) {
      wx.showModal({
        title: '需先绑定手机号',
        content: '申请采购准入前，必须先在个人中心完成微信手机号绑定。',
        confirmText: '去绑定',
        showCancel: false,
        success: function() {
          wx.navigateBack({
            fail: function() {
              wx.switchTab({ url: '/pages/mine/index' });
            }
          });
        }
      });
      return;
    }

    // 手机号默认为绑定的手机号，并预填已有资料
    this.setData({
      phone: user.phone || '',
      hospitalName: user.customerName || user.applyHospitalName || '',
      realName: user.realName || '',
      department: user.department || ''
    });

    if (user.approvalStatus === 'APPROVED') {
      wx.setNavigationBarTitle({ title: '资质认证信息' });
      this.setData({
        isApproved: true,
        user: user,
        statusText: '认证采购'
      });
    }

    this.prefillUser();
  },

  prefillUser: function() {
    var self = this;
    var user = procurement.getUserInfo();
    if (user) {
      var isApp = (user.approvalStatus === 'APPROVED');
      if (isApp) {
        wx.setNavigationBarTitle({ title: '资质认证信息' });
      }
      self.setData({
        isApproved: isApp,
        user: user,
        statusText: isApp ? '认证采购' : '',
        hospitalName: user.customerName || user.applyHospitalName || '',
        realName: user.realName || '',
        department: user.department || '',
        phone: user.phone || '',
        isPending: (user.approvalStatus === 'PENDING')
      });
    }

    procurement.request('proc_profile')
      .then(function(res) {
        if (res.status === 1 && res.user) {
          var u = procurement.setUserInfo(res.user);
          var isApp = (u.approvalStatus === 'APPROVED');
          if (isApp) {
            wx.setNavigationBarTitle({ title: '资质认证信息' });
          }
          self.setData({
            isApproved: isApp,
            user: u,
            statusText: isApp ? '认证采购' : '',
            hospitalName: u.customerName || u.applyHospitalName || self.data.hospitalName,
            realName: u.realName || self.data.realName,
            department: u.department || self.data.department,
            phone: u.phone || self.data.phone,
            isPending: (u.approvalStatus === 'PENDING')
          });
        }
      })
      .catch(function() {});
  },

  onInputHospital: function(e) {
    this.setData({ hospitalName: e.detail.value });
  },

  onInputRealName: function(e) {
    this.setData({ realName: e.detail.value });
  },

  onInputDepartment: function(e) {
    this.setData({ department: e.detail.value });
  },

  submitApply: function() {
    var self = this;
    if (self.data.isPending) {
      wx.showModal({
        title: '申请审核中',
        content: '您提交的采购准入申请正在由后台管理员审核中，无需重复提交。',
        showCancel: false,
        confirmText: '知道了'
      });
      return;
    }

    var hospitalName = (self.data.hospitalName || '').trim();
    var realName = (self.data.realName || '').trim();
    var department = (self.data.department || '').trim();
    var phone = (self.data.phone || '').trim();

    // 1. 合作医院名称验证：至少四个字
    if (!hospitalName) {
      wx.showToast({ title: '请填写合作医院名称', icon: 'none' });
      return;
    }
    if (hospitalName.length < 4) {
      wx.showToast({ title: '医院名称至少需要4个字', icon: 'none' });
      return;
    }

    // 2. 真实姓名验证：限制为2-4个汉字
    if (!realName) {
      wx.showToast({ title: '请填写真实姓名', icon: 'none' });
      return;
    }
    var chineseNameReg = /^[\u4e00-\u9fa5]{2,4}$/;
    if (!chineseNameReg.test(realName)) {
      wx.showToast({ title: '姓名必须为2-4个汉字', icon: 'none' });
      return;
    }

    // 3. 手机号验证：默认为当前绑定的11位有效手机号
    if (!phone || !/^1\d{10}$/.test(phone)) {
      wx.showModal({
        title: '需先绑定手机号',
        content: '申请采购准入必须使用已绑定的手机号，请在个人中心先绑定手机号。',
        confirmText: '去绑定',
        showCancel: false,
        success: function() {
          wx.navigateBack({
            fail: function() {
              wx.switchTab({ url: '/pages/mine/index' });
            }
          });
        }
      });
      return;
    }

    // 4. 科室为选填，允许为空字符

    self.setData({ submitting: true });
    wx.showLoading({ title: '正在提交...' });

    procurement.request('proc_apply', {
      hospitalName: hospitalName,
      realName: realName,
      department: department,
      phone: phone
    })
      .then(function(res) {
        wx.hideLoading();
        self.setData({ submitting: false });

        if (res.status === 1) {
          if (res.user) {
            procurement.setUserInfo(res.user);
          }
          wx.setStorageSync('proc_last_approval_status', 'PENDING');

          wx.showModal({
            title: '准入申请已提交',
            content: '您的医院采购员准入申请已提交成功，后台管理员审核通过后将即时开通耗材目录与协议价格权限。',
            showCancel: false,
            confirmText: '确定',
            success: function() {
              wx.navigateBack({
                fail: function() {
                  wx.switchTab({ url: '/pages/mine/index' });
                }
              });
            }
          });
        } else {
          wx.showModal({
            title: '提交提示',
            content: res.msg || '提交失败',
            showCancel: false
          });
        }
      })
      .catch(function(err) {
        wx.hideLoading();
        self.setData({ submitting: false });
        wx.showToast({ title: (err && err.message) || '网络异常', icon: 'none' });
      });
  },

  goToOrderIndex: function() {
    wx.switchTab({
      url: '/pages/order/index'
    });
  },

  goToOrderList: function() {
    wx.navigateTo({
      url: '/pages/order/list'
    });
  }
});
