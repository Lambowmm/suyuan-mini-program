const api = require('../../utils/api');
const dateUtil = require('../../utils/date');
const lis = require('../../utils/lis');

Page({
  data: {
    mode: 'pathology',
    query: {
      sendHospital: '',
      password: '',
      regeditTime: '',
      regeditEndTime: ''
    },
    calendarVisible: false, calendarValue: [], calendarMin: 0, calendarMax: 0,
    submitting: false,
    lisSignedIn: false
  },

  onLoad: function(options) {
    var range = dateUtil.defaultRange();
    // 最近一周包含今天，共七个自然日。
    var start = new Date(this.dateTimestamp(range.today));
    start.setDate(start.getDate() - 6);
    range.start = this.calendarDay(start.getTime());
    var savedHospital = this.getSavedAccount();
    var auth = lis.getAuth();
    this._accounts = { pathology: savedHospital, lis: (auth && auth.username) || '' };
    var mode = options && options.mode === 'lis' || auth ? 'lis' : 'pathology';

    this.setData({
      mode: mode,
      'query.sendHospital': mode === 'lis' ? (auth && auth.username || '') : savedHospital,
      'query.regeditTime': range.start,
      'query.regeditEndTime': range.end
    });
    if (mode === 'lis') this.checkLisAuth();
  },

  onShow: function() {
    if (this.data.mode === 'lis') this.checkLisAuth();
  },

  checkLisAuth: function() {
    var that = this;
    if (!lis.getAuth()) {
      this.setData({ lisSignedIn: false });
      return;
    }
    lis.readyAuth().then(function(auth) {
      that.setData({ lisSignedIn: that.data.mode === 'lis' && auth.username === that.data.query.sendHospital.trim() });
    }).catch(function() {
      that.setData({ lisSignedIn: false });
    });
  },

  getSavedAccount: function() {
    return wx.getStorageSync('pathologyAccount') || '';
  },

  setMode: function(event) {
    if (this.data.submitting) return;
    var mode = event.currentTarget.dataset.mode || 'pathology';
    if (mode === this.data.mode) {
      return;
    }

    this._accounts = this._accounts || {};
    this._accounts[this.data.mode] = this.data.query.sendHospital;
    this.setData({
      mode: mode,
      'query.sendHospital': this._accounts[mode] || '',
      'query.password': '',
      lisSignedIn: false
    });
    if (mode === 'lis') this.checkLisAuth();
  },

  onInput: function(event) {
    var field = event.currentTarget.dataset.field;
    this.setData({
      ['query.' + field]: event.detail.value,
      ...(field === 'sendHospital' && this.data.mode === 'lis' ? { lisSignedIn: (lis.getAuth() || {}).username === event.detail.value.trim() } : {})
    });
  },

  dateTimestamp: function(day) {
    var parts = day.split('-').map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2]).getTime();
  },

  calendarDay: function(value) {
    var date = new Date(value);
    return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
  },

  openDateRange: function() {
    var start = this.dateTimestamp(this.data.query.regeditTime);
    var end = this.dateTimestamp(this.data.query.regeditEndTime);
    this.setData({
      calendarVisible: true, calendarValue: [start, end],
      calendarMin: Math.min(new Date(2000, 0, 1).getTime(), start),
      calendarMax: this.dateTimestamp(dateUtil.defaultRange().today)
    });
  },

  closeDateRange: function(event) {
    // TDesign emits close before confirm; confirmation commits the selected range.
    if (event && event.detail && event.detail.trigger === 'confirm-btn') return;
    this.setData({ calendarVisible: false });
  },

  confirmDateRange: function(event) {
    var values = event.detail.value;
    if (!Array.isArray(values) || values.length !== 2 || !values.every(Number.isFinite)) {
      wx.showToast({ title: '请选择开始和结束日期', icon: 'none' }); return;
    }
    var start = this.calendarDay(values[0]);
    var end = this.calendarDay(values[1]);
    if (start > end || values[1] > this.data.calendarMax) {
      wx.showToast({ title: '请选择有效的报告日期范围', icon: 'none' }); return;
    }
    this.setData({ calendarVisible: false, 'query.regeditTime': start, 'query.regeditEndTime': end });
  },

  validateQuery: function() {
    var query = this.data.query;

    if (!query.sendHospital || !query.sendHospital.trim()) {
      return this.data.mode === 'lis' ? '请输入检验账号' : '请输入病理账号';
    }
    var auth = lis.getAuth();
    var signedIn = this.data.mode === 'lis' && this.data.lisSignedIn && auth && auth.username === query.sendHospital.trim();
    if (!query.password && !signedIn) {
      return '请输入查询密码';
    }
    if (!query.regeditTime || !query.regeditEndTime) {
      return '请选择报告日期范围';
    }
    if (dateUtil.compareDate(query.regeditTime, query.regeditEndTime) > 0) {
      return '开始日期不能晚于结束日期';
    }

    return '';
  },

  submitQuery: function() {
    if (this.data.submitting) return;
    var that = this;
    var message = this.validateQuery();
    var query = this.data.query;

    if (message) {
      wx.showToast({
        title: message,
        icon: 'none'
      });
      return;
    }

    this.setData({
      submitting: true
    });

    if (this.data.mode === 'lis') {
      var username = query.sendHospital.trim();
      var auth = lis.getAuth();
      var signedIn = this.data.lisSignedIn && auth && auth.username === username;
      var login = signedIn ? lis.readyAuth() : lis.login(username, query.password);
      login.then(function() {
        var reportQuery = {
          reportKind: 'lis', reportTitle: '检验报告', sendHospital: username,
          regeditTime: query.regeditTime, regeditEndTime: query.regeditEndTime,
          summaryName: username
        };
        var app = getApp();
        app.globalData.currentReportQuery = reportQuery;
        app.globalData.currentReportList = null;
        that.setData({ 'query.password': '', lisSignedIn: true });
        wx.navigateTo({ url: '/pages/report/result' });
      }).catch(function(error) {
        if (error.authExpired) that.setData({ lisSignedIn: false });
        wx.showToast({ title: error.message || '检验登录失败', icon: 'none' });
      }).then(function() { that.setData({ submitting: false }); });
      return;
    }

    var reportQuery = {
      reportKind: this.data.mode,
      reportTitle: this.data.mode === 'lis' ? '检验报告' : '病理报告',
      sendHospital: query.sendHospital.trim(),
      password: query.password,
      regeditTime: query.regeditTime,
      regeditEndTime: query.regeditEndTime,
      summaryName: query.sendHospital.trim()
    };

    var params = api.buildReportListParams(reportQuery);

    api.request(params).then(function(result) {
        if (result.status !== 1) {
          throw new Error(result.msg || '查询失败，请核对医院代码和密码');
        }

        wx.setStorageSync('pathologyAccount', reportQuery.sendHospital);

        var app = getApp();
        app.globalData.currentReportQuery = reportQuery;
        app.globalData.currentReportList = result.list || [];
        app.globalData.currentPathologyQuery = reportQuery;
        app.globalData.currentPathologyList = result.list || [];

        wx.navigateTo({
          url: '/pages/report/result'
        });
    }).catch(function(error) {
      wx.showToast({
        title: error.message || '查询失败，请稍后重试',
        icon: 'none'
      });
    }).then(function() {
      that.setData({
        submitting: false
      });
    });
  }
});
