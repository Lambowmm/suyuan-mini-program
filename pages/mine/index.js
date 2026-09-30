const procurement = require('../../utils/procurement');

const STATUS_TEXT = {
  APPROVED: '认证采购',
  PENDING: '审核中',
  REJECTED: '已驳回',
  DISABLED: '已停用'
};

const DEFAULT_AVATAR = 'https://mmbiz.qpic.cn/mmbiz/icTdbqWNOwNRna42FI242Lcia07jQodd2FJGIYQfG0LAJGFxM4FbnQP6yfMxBgJ0F3YRqJCJ1aPAK2dQagdusBZg/0';

Page({
  data: {
    isLoggedIn: false,
    user: null,
    statusText: '未认证',
    defaultAvatarUrl: DEFAULT_AVATAR,
    approvedNoticeDismissed: false,
    approvedCardDismissed: false
  },

  onShow: function() {
    this.refreshUserInfo();
  },

  onHide: function() {
    var user = this.data.user;
    if (user && user.userId && user.approvalStatus === 'APPROVED') {
      wx.setStorageSync('proc_approved_card_dismissed_' + user.userId, 1);
      wx.setStorageSync('proc_approved_notice_dismissed_' + user.userId, 1);
    }
    if (this._noticeTimer) {
      clearTimeout(this._noticeTimer);
      this._noticeTimer = null;
    }
  },

  onUnload: function() {
    if (this._noticeTimer) {
      clearTimeout(this._noticeTimer);
      this._noticeTimer = null;
    }
  },

  refreshUserInfo: function() {
    var self = this;
    var token = procurement.getToken();
    if (!token) {
      self.setData({
        isLoggedIn: false,
        user: null,
        statusText: '未认证'
      });
      return;
    }

    procurement.request('proc_profile')
      .then(function(res) {
        if (res.status === 1 && res.user) {
          var user = procurement.setUserInfo(res.user);
          var status = user.approvalStatus;

          // 审核状态变更实时通知弹窗
          var lastStatus = wx.getStorageSync('proc_last_approval_status');
          if (lastStatus && lastStatus === 'PENDING' && status === 'APPROVED') {
            wx.showModal({
              title: '采购准入已通过',
              content: '恭喜！您申请的【' + (user.customerName || '合作医院') + '】采购准入已审核通过！现已为您开通准入耗材目录、专享协议价与在线订购权限。',
              confirmText: '去采购',
              cancelText: '知道了',
              success: function(sm) {
                if (sm.confirm) {
                  wx.switchTab({ url: '/pages/order/index' });
                }
              }
            });
          } else if (lastStatus && lastStatus === 'PENDING' && status === 'REJECTED') {
            wx.showModal({
              title: '准入申请已被驳回',
              content: '很遗憾，您的采购准入申请已被管理员驳回。\n驳回原因：' + (user.rejectReason || '未提供具体原因') + '\n请核实申请信息与所属医院信息后重新提交。',
              showCancel: false,
              confirmText: '知道了'
            });
          }
          wx.setStorageSync('proc_last_approval_status', status);

          var noticeDismissed = !!wx.getStorageSync('proc_approved_notice_dismissed_' + user.userId);
          var cardDismissed = !!wx.getStorageSync('proc_approved_card_dismissed_' + user.userId);

          self.setData({
            isLoggedIn: true,
            user: user,
            statusText: STATUS_TEXT[status] || '未认证',
            approvedNoticeDismissed: noticeDismissed,
            approvedCardDismissed: cardDismissed
          });

          // 若审核通过且横幅未关闭，5秒后自动淡出消失，避免常驻遮挡
          if (status === 'APPROVED' && !noticeDismissed) {
            if (self._noticeTimer) clearTimeout(self._noticeTimer);
            self._noticeTimer = setTimeout(function() {
              self.dismissApprovedNotice(true);
            }, 5000);
          }
        } else {
          procurement.clearSession();
          self.setData({
            isLoggedIn: false,
            user: null,
            statusText: '未认证'
          });
        }
      })
      .catch(function() {
        var cached = procurement.getUserInfo();
        if (cached) {
          var noticeDismissed = !!wx.getStorageSync('proc_approved_notice_dismissed_' + cached.userId);
          var cardDismissed = !!wx.getStorageSync('proc_approved_card_dismissed_' + cached.userId);
          self.setData({
            isLoggedIn: true,
            user: cached,
            statusText: STATUS_TEXT[cached.approvalStatus] || '未认证',
            approvedNoticeDismissed: noticeDismissed,
            approvedCardDismissed: cardDismissed
          });
        }
      });
  },

  doLogin: function() {
    var self = this;
    wx.showLoading({ title: '正在登录...' });
    procurement.login()
      .then(function(res) {
        wx.hideLoading();
        wx.showToast({ title: '登录成功', icon: 'success' });
        self.refreshUserInfo();
      })
      .catch(function(err) {
        wx.hideLoading();
        wx.showToast({ title: (err && err.message) || '微信登录失败', icon: 'none' });
      });
  },

  onChooseAvatar: function(e) {
    var self = this;
    var avatarUrl = e.detail && e.detail.avatarUrl;
    if (!avatarUrl) return;

    var currentUser = self.data.user || {};
    var updated = Object.assign({}, currentUser, { avatarUrl: avatarUrl });
    procurement.setUserInfo(updated);
    self.setData({ user: updated });

    // 同步到后台数据库
    procurement.updateAvatar(avatarUrl)
      .then(function() {
        wx.showToast({ title: '头像已更新', icon: 'success' });
      })
      .catch(function() {
        wx.showToast({ title: '头像已本地保存', icon: 'none' });
      });
  },

  onGetPhoneNumber: function(e) {
    var self = this;
    if (!self.data.isLoggedIn) {
      wx.showToast({ title: '请先完成微信登录', icon: 'none' });
      return;
    }

    if (!e.detail.code) {
      if (e.detail.errMsg && (e.detail.errMsg.indexOf('cancel') >= 0 || e.detail.errMsg.indexOf('deny') >= 0)) {
        wx.showToast({ title: '已取消手机号授权', icon: 'none' });
      } else {
        wx.showToast({ title: '获取手机号失败: ' + (e.detail.errMsg || '请重试'), icon: 'none' });
      }
      return;
    }

    wx.showLoading({ title: '正在绑定微信手机号...' });
    procurement.bindPhoneNumber({
      code: e.detail.code,
      encryptedData: e.detail.encryptedData,
      iv: e.detail.iv
    })
      .then(function(res) {
        wx.hideLoading();
        if (res.status === 1) {
          wx.showToast({ title: '手机号绑定成功', icon: 'success' });
          self.refreshUserInfo();
        } else {
          wx.showModal({
            title: '绑定提示',
            content: res.msg || '手机号绑定失败',
            showCancel: false
          });
        }
      })
      .catch(function(err) {
        wx.hideLoading();
        wx.showToast({ title: (err && err.message) || '网络异常', icon: 'none' });
      });
  },

  goToApply: function() {
    var self = this;
    if (!self.data.isLoggedIn) {
      wx.showToast({ title: '请先完成微信登录', icon: 'none' });
      return;
    }

    var user = self.data.user || {};
    // 必须完成手机号绑定才能申请采购准入
    if (!user.phone) {
      wx.showModal({
        title: '需先绑定手机号',
        content: '根据采购准入合规要求，请先一键绑定微信手机号，方可提交采购准入申请。',
        confirmText: '去绑定',
        showCancel: false
      });
      return;
    }

    // 已认证、审核中或未申请，均前往【准入申请/资质认证】页面
    // 认证完成的用户可在该页面查阅完整的准入资质证书详情
    wx.navigateTo({
      url: '/pages/mine/apply'
    });
  },

  dismissApprovedNotice: function(silent) {
    var user = this.data.user;
    if (user && user.userId) {
      wx.setStorageSync('proc_approved_notice_dismissed_' + user.userId, 1);
    }
    this.setData({ approvedNoticeDismissed: true });
    if (this._noticeTimer) {
      clearTimeout(this._noticeTimer);
      this._noticeTimer = null;
    }
    if (silent !== true) {
      wx.showToast({ title: '已关闭通知', icon: 'none' });
    }
  },

  dismissApprovedCard: function() {
    var user = this.data.user;
    if (user && user.userId) {
      wx.setStorageSync('proc_approved_card_dismissed_' + user.userId, 1);
    }
    this.setData({ approvedCardDismissed: true });
    wx.showToast({ title: '资质信息已收起', icon: 'none' });
  },

  doLogout: function() {
    var self = this;
    wx.showModal({
      title: '确认退出',
      content: '退出登录后将清除本地会话缓存，是否继续？',
      success: function(sm) {
        if (sm.confirm) {
          procurement.clearSession();
          self.setData({
            isLoggedIn: false,
            user: null,
            statusText: '未认证'
          });
          wx.showToast({ title: '已退出登录', icon: 'success' });
        }
      }
    });
  },

  goToOrderList: function() {
    if (!this.data.isLoggedIn) {
      wx.showToast({ title: '请先登录系统', icon: 'none' });
      return;
    }
    wx.navigateTo({
      url: '/pages/order/list'
    });
  },

  goToCart: function() {
    wx.navigateTo({
      url: '/pages/order/cart'
    });
  },

  goToSettlement: function() {
    if (!this.data.isLoggedIn) {
      wx.showToast({ title: '请先登录系统', icon: 'none' });
      return;
    }
    wx.navigateTo({
      url: '/pages/mine/settlement'
    });
  },

  goToReport: function() {
    wx.switchTab({
      url: '/pages/report/index',
      fail: function() {
        wx.navigateTo({ url: '/pages/report/index' });
      }
    });
  }
});
