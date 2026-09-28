const api = require('../../utils/api');
const lis = require('../../utils/lis');
const dateUtil = require('../../utils/date');
const reportOrder = require('../../utils/report-order');

function lisTime(day, end) {
  return day + (end ? 'T23:59:59+08:00' : 'T00:00:00+08:00');
}

function isLisQuery(query) {
  return query && query.reportKind === 'lis';
}

function redirectToReportIndex() {
  wx.redirectTo({
    url: '/pages/report/index'
  });
}

function normalizeReports(list) {
  return (list || []).map(function(item, index) {
    var report = Object.assign({}, item);
    var reportType = report.ReportType || '病理报告';
    var patientName = report.PatientName || '';
    patientName = patientName ? String(patientName).trim() : '';

    report.ReportID = report.ReportID || report.ReportId || report.reportId || report.reportID;
    report._key = report.ReportID || 'report-' + index;
    report._patientName = patientName || '患者信息';
    report._reportType = reportType;
    report._date = report.ReCheckDate || '暂无日期';
    report._typeTag = /免疫|组化|ihc/i.test(reportType) ? '免' : '病';
    return report;
  });
}

function normalizeLisReports(list) {
  return (list || []).map(function(item) {
    var report = Object.assign({}, item);
    report.ReportID = report.id;
    report._key = String(report.id);
    report._patientName = report.patientName || '患者信息';
    report._reportType = report.groupNames || report.reportType || '检验报告';
    report._date = report.reportTime || '暂无日期';
    report._barcode = report.relBarcode || report.barcode || '';
    report._typeTag = '检';
    return report;
  });
}

Page({
  data: {
    query: null, keyword: '', appliedKeyword: '', reports: [],
    total: 0, totalPages: 0, currentPage: 1, paginationItems: [],
    pageSize: 30, pageSizes: [30, 50, 100], pageSizeIndex: 0,
    sortOrder: 'desc', sortOptions: ['时间倒序', '时间正序'], sortIndex: 0,
    startDate: '', endDate: '', tempStartDate: '', tempEndDate: '',
    calendarVisible: false, calendarValue: [], calendarMin: 0, calendarMax: 0,
    criticalFilter: false, abnormalFilter: false,
    stats: null, loadError: '', loading: false, searched: false,
    previewingId: '', downloadingId: ''
  },

  onLoad: function() {
    var app = getApp();
    var query = app.globalData.currentReportQuery || app.globalData.currentPathologyQuery;
    if (!query) { redirectToReportIndex(); return; }
    this.setData({ query: Object.assign({}, query), startDate: query.regeditTime, endDate: query.regeditEndTime });
    wx.setNavigationBarTitle({ title: isLisQuery(query) ? '检验报告' : '病理报告' });
    var cached = app.globalData.currentReportList || app.globalData.currentPathologyList;
    if (!isLisQuery(query) && Array.isArray(cached)) {
      this._pathologyReports = normalizeReports(cached);
      this.showPathologyPage(1);
    } else this.refreshResults();
    if (isLisQuery(query)) this.fetchLisStats();
  },

  onShow: function() {
    if (isLisQuery(this.data.query)) lis.readyAuth().catch(function() {});
  },

  onUnload: function() {
    this._requestId = (this._requestId || 0) + 1;
    this._statsGeneration = (this._statsGeneration || 0) + 1;
  },

  onPullDownRefresh: function() {
    this.refreshResults(function() { wx.stopPullDownRefresh(); });
    if (isLisQuery(this.data.query)) this.fetchLisStats();
  },

  openDateRange: function() {
    var start = this.dateTimestamp(this.data.startDate);
    var end = this.dateTimestamp(this.data.endDate);
    var today = this.dateTimestamp(dateUtil.defaultRange().today);
    this.setData({
      tempStartDate: this.data.startDate, tempEndDate: this.data.endDate,
      calendarValue: [start, end], calendarVisible: true,
      calendarMin: Math.min(new Date(2000, 0, 1).getTime(), start),
      calendarMax: Math.max(today, end)
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

  onCalendarSelect: function(event) {
    var values = event.detail.value || [];
    this.setData({ tempStartDate: values.length ? this.calendarDay(values[0]) : '', tempEndDate: values.length === 2 ? this.calendarDay(values[1]) : '' });
  },

  closeDateRange: function(event) {
    // TDesign emits close before confirm; confirmation owns the committed values.
    if (event && event.detail && event.detail.trigger === 'confirm-btn') return;
    this.setData({ calendarVisible: false, tempStartDate: this.data.startDate, tempEndDate: this.data.endDate });
  },

  confirmDateRange: function(event) {
    var values = event.detail.value;
    if (!Array.isArray(values) || values.length !== 2 || !values.every(Number.isFinite)) {
      wx.showToast({ title: '请选择开始和结束日期', icon: 'none' }); return;
    }
    var start = this.calendarDay(values[0]);
    var end = this.calendarDay(values[1]);
    if (start > end) { wx.showToast({ title: '开始日期不能晚于结束日期', icon: 'none' }); return; }
    this.setData({ calendarVisible: false, tempStartDate: start, tempEndDate: end });
    if (start === this.data.startDate && end === this.data.endDate) return;
    var query = Object.assign({}, this.data.query, { regeditTime: start, regeditEndTime: end });
    this.setData({ startDate: start, endDate: end, query: query, stats: null });
    getApp().globalData.currentReportQuery = query;
    if (!isLisQuery(query)) getApp().globalData.currentPathologyQuery = query;
    this.refreshResults();
    if (isLisQuery(query)) this.fetchLisStats();
  },

  onPageSizeChange: function(event) {
    var index = Number(event.detail.value);
    if (!this.data.pageSizes[index] || index === this.data.pageSizeIndex) return;
    this.setData({ pageSizeIndex: index, pageSize: this.data.pageSizes[index] });
    this.refreshResults();
  },

  onSortChange: function(event) {
    var index = Number(event.detail.value);
    if ((index !== 0 && index !== 1) || index === this.data.sortIndex) return;
    this.setData({ sortIndex: index, sortOrder: index === 1 ? 'asc' : 'desc' });
    this.refreshResults();
  },

  toggleLisFilter: function(event) {
    var field = event.currentTarget.dataset.field;
    if (field !== 'criticalFilter' && field !== 'abnormalFilter') return;
    this.setData({ [field]: !this.data[field] });
    this.refreshResults();
  },

  onKeywordInput: function(event) { this.setData({ keyword: event.detail.value }); },
  onKeywordConfirm: function() {
    this.setData({ appliedKeyword: this.data.keyword.trim() });
    this.refreshResults();
  },
  clearKeyword: function() {
    this.setData({ keyword: '', appliedKeyword: '' });
    this.refreshResults();
  },

  lisQueryParams: function(page) {
    var params = { beginTime: lisTime(this.data.startDate, false), endTime: lisTime(this.data.endDate, true), page: page, pageSize: this.data.pageSize };
    if (this.data.appliedKeyword) params.patientName = this.data.appliedKeyword;
    if (this.data.criticalFilter) params.hasDanger = true;
    if (this.data.abnormalFilter) params.hasAbnormal = true;
    return params;
  },

  refreshResults: function(done) {
    this._requestId = (this._requestId || 0) + 1;
    this.setData({ currentPage: 1, total: 0, totalPages: 0, paginationItems: [], reports: [], loading: false, searched: false, loadError: '' });
    if (isLisQuery(this.data.query)) {
      this._lisParams = this.lisQueryParams(1);
      this._ascendingPage = this.data.sortOrder === 'asc' ? reportOrder.ascendingPager(lis.request, this._lisParams) : null;
      return this.fetchLisPage(1, false, done);
    }
    return this.fetchPathology(done);
  },

  pagination: function(page, totalPages) {
    var items = [];
    for (var p = 1; p <= totalPages; p++) {
      if (totalPages <= 7 || p === 1 || p === totalPages || Math.abs(p - page) <= 1) items.push({ key: 'page-' + p, page: p, label: String(p) });
      else if (!items.length || items[items.length - 1].page !== 0) items.push({ key: 'gap-' + p, page: 0, label: '…' });
    }
    return items;
  },

  changePage: function(event) {
    var page = Number(event.currentTarget.dataset.page);
    if (this.data.loading || !Number.isInteger(page) || page < 1 || page > this.data.totalPages || page === this.data.currentPage) return;
    if (isLisQuery(this.data.query)) return this.fetchLisPage(page, true);
    this.showPathologyPage(page, true);
  },

  scrollToReports: function() { wx.pageScrollTo({ selector: '#report-results', duration: 200 }); },

  retryPage: function() {
    if (this.data.loading) return;
    if (isLisQuery(this.data.query)) return this.fetchLisPage(this.data.currentPage, false);
    return this.fetchPathology();
  },

  fetchLisPage: function(page, scroll, done) {
    var that = this;
    var requestId = (this._requestId || 0) + 1;
    this._requestId = requestId;
    var params = Object.assign({}, this._lisParams, { page: page });
    this.setData({ currentPage: page, reports: [], loading: true, loadError: '' });
    this._pagePromise = (this._ascendingPage ? this._ascendingPage(page) : lis.request('/reports', params)).then(function(result) {
      if (requestId !== that._requestId) return;
      if (!Array.isArray(result.items) || !Number.isInteger(result.total) || result.total < 0) throw new Error('检验列表响应格式异常');
      var totalPages = Math.ceil(result.total / that.data.pageSize);
      if (totalPages > 0 && page > totalPages) return that.fetchLisPage(1, scroll);
      var seen = Object.create(null);
      var reports = normalizeLisReports(result.items).filter(function(report) {
        var id = String(report.id);
        if (seen[id]) return false;
        seen[id] = true; return true;
      }).slice(0, that.data.pageSize);
      var currentPage = totalPages ? page : 1;
      that.setData({ reports: reports, total: result.total, totalPages: totalPages, currentPage: currentPage, paginationItems: that.pagination(currentPage, totalPages), searched: true }, function() { if (scroll) that.scrollToReports(); });
    }).catch(function(error) {
      if (requestId === that._requestId && !error.authExpired) that.setData({ loadError: error.message || '检验报告查询失败' });
    }).then(function() {
      if (requestId === that._requestId) that.setData({ loading: false });
      if (done) done();
    });
    return this._pagePromise;
  },

  showPathologyPage: function(page, scroll) {
    var list = reportOrder.sortReports(this._pathologyReports || [], this.data.sortOrder);
    var totalPages = Math.ceil(list.length / this.data.pageSize);
    var currentPage = Math.max(1, Math.min(page, totalPages || 1));
    var start = (currentPage - 1) * this.data.pageSize;
    var that = this;
    this.setData({ reports: list.slice(start, start + this.data.pageSize), total: list.length, totalPages: totalPages, currentPage: currentPage, paginationItems: this.pagination(currentPage, totalPages), searched: true }, function() { if (scroll) that.scrollToReports(); });
  },

  fetchPathology: function(done) {
    var that = this;
    var requestId = (this._requestId || 0) + 1;
    this._requestId = requestId;
    this.setData({ loading: true, loadError: '', reports: [] });
    var params = api.buildReportListParams(this.data.query, this.data.appliedKeyword);
    this._pagePromise = api.request(params).then(function(result) {
      if (requestId !== that._requestId) return;
      if (result.status !== 1) throw new Error(result.msg || '报告查询失败');
      that._pathologyReports = normalizeReports(result.list || []);
      getApp().globalData.currentReportList = result.list || [];
      getApp().globalData.currentPathologyList = result.list || [];
      that.showPathologyPage(that.data.currentPage);
    }).catch(function(error) {
      if (requestId === that._requestId) that.setData({ loadError: error.message || '报告查询失败' });
    }).then(function() {
      if (requestId === that._requestId) that.setData({ loading: false });
      if (done) done();
    });
    return this._pagePromise;
  },

  fetchLisStats: function() {
    var that = this;
    var generation = (this._statsGeneration || 0) + 1;
    this._statsGeneration = generation;
    lis.request('/reports/stats', { beginTime: lisTime(this.data.startDate, false), endTime: lisTime(this.data.endDate, true) }).then(function(stats) {
      if (generation === that._statsGeneration) that.setData({ stats: stats });
    }).catch(function() {});
  },

  getReportFromEvent: function(event) {
    var index = event.currentTarget.dataset.index;
    return this.data.reports[index];
  },

  validateReport: function(report) {
    if (!report || !report.ReportID) {
      wx.showToast({
        title: '报告编号缺失',
        icon: 'none'
      });
      return false;
    }
    return true;
  },

  fetchReportDetail: function(report) {
    return api.request({
      action: 'reportDetail2',
      reportID: report.ReportID,
      patientName: report._patientName === '患者信息' ? '' : report._patientName,
      reportType: report._reportType || ''
    }).then(function(result) {
      if (result.status !== 1) {
        throw new Error(result.msg || '打开报告失败');
      }
      return result;
    });
  },

  openReport: function(event) {
    var report = this.getReportFromEvent(event);
    var that = this;

    if (!this.validateReport(report)) {
      return;
    }

    if (isLisQuery(this.data.query)) { this.openLisReport(report, false); return; }

    this.setData({
      previewingId: report.ReportID
    });

    this.fetchReportDetail(report).then(function(result) {
      that.previewReportResult(result, report);
    }).catch(function(error) {
      wx.showToast({
        title: error.message || '打开报告失败',
        icon: 'none'
      });
    }).then(function() {
      that.setData({
        previewingId: ''
      });
    });
  },

  downloadReport: function(event) {
    var report = this.getReportFromEvent(event);
    var that = this;

    if (!this.validateReport(report)) {
      return;
    }

    if (isLisQuery(this.data.query)) { this.openLisReport(report, true); return; }

    this.setData({
      downloadingId: report.ReportID
    });

    this.fetchReportDetail(report).then(function(result) {
      that.downloadReportResult(result, report);
    }).catch(function(error) {
      wx.showToast({
        title: error.message || '下载报告失败',
        icon: 'none'
      });
    }).then(function() {
      that.setData({
        downloadingId: ''
      });
    });
  },

  openLisReport: function(report, showMenu) {
    var that = this;
    var field = showMenu ? 'downloadingId' : 'previewingId';
    if (report.syncStatus === 'pending_pdf' || report.hasPdf === false) {
      wx.showToast({ title: 'PDF 尚未就绪，请稍后再试', icon: 'none' });
      return;
    }
    this.setData({ [field]: report.ReportID });
    lis.downloadReport(report.id).then(function(filePath) {
      that.openDocumentFile(filePath, 'pdf', showMenu);
    }).catch(function(error) {
      if (!error.authExpired) wx.showToast({ title: error.message || '打开报告失败', icon: 'none' });
    }).then(function() { that.setData({ [field]: '' }); });
  },

  previewReportResult: function(result, report) {
    if (result.path) {
      this.openRemoteDocument(result.path, false, this.buildDocumentFileName(report, result.path));
      return;
    }

    if (!result.list || !result.list.ReportData) {
      throw new Error('暂无可预览报告');
    }

    this.previewBase64Image(result.list.ReportData, report.ReportID);
  },

  downloadReportResult: function(result, report) {
    if (result.path) {
      this.openRemoteDocument(result.path, true, this.buildDocumentFileName(report, result.path));
      return;
    }

    if (!result.list || !result.list.ReportData) {
      throw new Error('暂无可下载报告');
    }

    this.saveBase64Image(result.list.ReportData, report.ReportID);
  },

  previewBase64Image: function(reportData, reportID) {
    var base64 = reportData.replace(/^data:image\/\w+;base64,/, '');
    var safeReportID = String(reportID).replace(/[^\w-]/g, '_');
    var filePath = wx.env.USER_DATA_PATH + '/pathology-report-' + safeReportID + '.png';
    var fs = wx.getFileSystemManager();

    fs.writeFile({
      filePath: filePath,
      data: base64,
      encoding: 'base64',
      success: function() {
        wx.previewImage({
          current: filePath,
          urls: [filePath]
        });
      },
      fail: function() {
        wx.showToast({
          title: '报告图片生成失败',
          icon: 'none'
        });
      }
    });
  },

  saveBase64Image: function(reportData, reportID) {
    var base64 = reportData.replace(/^data:image\/\w+;base64,/, '');
    var safeReportID = String(reportID).replace(/[^\w-]/g, '_');
    var filePath = wx.env.USER_DATA_PATH + '/pathology-report-' + safeReportID + '.png';
    var fs = wx.getFileSystemManager();

    fs.writeFile({
      filePath: filePath,
      data: base64,
      encoding: 'base64',
      success: function() {
        wx.saveImageToPhotosAlbum({
          filePath: filePath,
          success: function() {
            wx.showToast({
              title: '已保存到相册',
              icon: 'success'
            });
          },
          fail: function() {
            wx.previewImage({
              current: filePath,
              urls: [filePath]
            });
          }
        });
      },
      fail: function() {
        wx.showToast({
          title: '报告图片保存失败',
          icon: 'none'
        });
      }
    });
  },

  buildDocumentFileName: function(report, url) {
    var patientName = this.sanitizeFileName(report._patientName === '患者信息' ? '' : report._patientName) || '患者信息';
    var reportType = this.sanitizeFileName(report._reportType) || '病理报告';
    var fileType = this.inferFileType(url) || 'pdf';
    return ('溯源-' + patientName + '-' + reportType).slice(0, 80) + '.' + fileType;
  },

  sanitizeFileName: function(value) {
    return String(value || '')
      .replace(/[\\/:*?"<>|]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  },

  openRemoteDocument: function(url, showMenu, fileName) {
    var that = this;
    wx.showLoading({
      title: showMenu ? '下载中' : '打开中'
    });

    wx.downloadFile({
      url: url,
      success: function(response) {
        if (response.statusCode !== 200) {
          wx.showToast({
            title: '报告文件下载失败',
            icon: 'none'
          });
          return;
        }

        if (!showMenu) {
          that.copyDocumentFile(response.tempFilePath, fileName, function(filePath) {
            that.openDocumentFile(filePath, that.inferFileType(fileName || url), false);
          });
          return;
        }

        that.copyDocumentFile(response.tempFilePath, fileName, function(filePath) {
          that.openDocumentFile(filePath, that.inferFileType(fileName || url), true);
        });
      },
      fail: function() {
        wx.showToast({
          title: '报告文件无法访问',
          icon: 'none'
        });
      },
      complete: function() {
        wx.hideLoading();
      }
    });
  },

  copyDocumentFile: function(tempFilePath, fileName, done) {
    if (!fileName) {
      done(tempFilePath);
      return;
    }

    var fs = wx.getFileSystemManager();
    var targetPath = wx.env.USER_DATA_PATH + '/' + fileName;
    fs.unlink({
      filePath: targetPath,
      complete: function() {
        fs.copyFile({
          srcPath: tempFilePath,
          destPath: targetPath,
          success: function() {
            done(targetPath);
          },
          fail: function() {
            done(tempFilePath);
          }
        });
      }
    });
  },

  openDocumentFile: function(filePath, fileType, showMenu) {
    var options = {
      filePath: filePath,
      showMenu: !!showMenu,
      fail: function() {
        wx.showToast({
          title: showMenu ? '报告文件暂不支持打开' : '该报告文件暂不支持预览',
          icon: 'none'
        });
      }
    };

    if (fileType) {
      options.fileType = fileType;
    }

    wx.openDocument(options);
  },

  inferFileType: function(url) {
    var cleanUrl = String(url || '').split('?')[0].split('#')[0];
    var match = cleanUrl.match(/\.([a-z0-9]+)$/i);
    return match ? match[1].toLowerCase() : '';
  }
});
