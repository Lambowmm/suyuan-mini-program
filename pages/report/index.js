const api = require('../../utils/api');
const dateUtil = require('../../utils/date');

Page({
  data: {
    mode: 'pathology',
    query: {
      sendHospital: '',
      password: '',
      regeditTime: '',
      regeditEndTime: ''
    },
    maxDate: '',
    submitting: false
  },

  onLoad: function() {
    var range = dateUtil.defaultRange();
    var savedHospital = this.getSavedAccount();

    this.setData({
      mode: 'pathology',
      maxDate: range.today,
      'query.sendHospital': savedHospital,
      'query.regeditTime': range.start,
      'query.regeditEndTime': range.end
    });
  },

  getSavedAccount: function() {
    return wx.getStorageSync('lastHospitalCode') || '';
  },

  setMode: function(event) {
    var mode = event.currentTarget.dataset.mode || 'pathology';
    if (mode === 'lis') {
      wx.showToast({
        title: '检验报告待接入',
        icon: 'none'
      });
      return;
    }

    if (mode === this.data.mode) {
      return;
    }

    this.setData({
      mode: mode,
      'query.sendHospital': this.getSavedAccount(),
      'query.password': ''
    });
  },

  onInput: function(event) {
    var field = event.currentTarget.dataset.field;
    this.setData({
      ['query.' + field]: event.detail.value
    });
  },

  onDateChange: function(event) {
    var field = event.currentTarget.dataset.field;
    this.setData({
      ['query.' + field]: event.detail.value
    });
  },

  validateQuery: function() {
    var query = this.data.query;

    if (this.data.mode === 'lis') {
      return '检验报告待接入';
    }

    if (!query.sendHospital || !query.sendHospital.trim()) {
      return '请输入送检医院代码';
    }
    if (!query.password) {
      return '请输入医院查询密码';
    }
    if (!query.regeditTime || !query.regeditEndTime) {
      return '请选择送检日期范围';
    }
    if (dateUtil.compareDate(query.regeditTime, query.regeditEndTime) > 0) {
      return '开始日期不能晚于结束日期';
    }

    return '';
  },

  submitQuery: function() {
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

    var reportQuery = {
      reportKind: 'pathology',
      reportTitle: '病理报告',
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

        wx.setStorageSync('lastHospitalCode', reportQuery.sendHospital);

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
