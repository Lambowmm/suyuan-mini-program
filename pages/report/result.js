const api = require('../../utils/api');

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

Page({
  data: {
    query: null,
    keyword: '',
    reports: [],
    loading: false,
    previewingId: '',
    downloadingId: '',
    searched: false
  },

  onLoad: function() {
    var app = getApp();
    var query = app.globalData.currentPathologyQuery;
    var list = app.globalData.currentPathologyList;

    if (!query && app.globalData.currentReportQuery && !isLisQuery(app.globalData.currentReportQuery)) {
      query = app.globalData.currentReportQuery;
      list = app.globalData.currentReportList;
    }

    if (!query) {
      wx.showToast({
        title: '请先提交查询',
        icon: 'none'
      });
      setTimeout(function() {
        redirectToReportIndex();
      }, 800);
      return;
    }

    if (isLisQuery(query)) {
      wx.showToast({
        title: '检验报告待接入',
        icon: 'none'
      });
      setTimeout(function() {
        redirectToReportIndex();
      }, 800);
      return;
    }

    wx.setNavigationBarTitle({
      title: '病理报告'
    });

    this.setData({
      query: query,
      reports: normalizeReports(list),
      searched: true
    });

    if (!list) {
      this.fetchReports('');
    }
  },

  onPullDownRefresh: function() {
    this.fetchReports(this.data.keyword, function() {
      wx.stopPullDownRefresh();
    });
  },

  onKeywordInput: function(event) {
    this.setData({
      keyword: event.detail.value
    });
  },

  onKeywordConfirm: function() {
    this.fetchReports(this.data.keyword);
  },

  clearKeyword: function() {
    this.setData({
      keyword: ''
    });
    this.fetchReports('');
  },

  fetchReports: function(keyword, done) {
    var that = this;
    var query = this.data.query;
    var cleanKeyword = keyword ? keyword.trim() : '';

    if (!query) {
      if (done) done();
      return;
    }

    this.setData({
      loading: true
    });

    if (isLisQuery(query)) {
      wx.showToast({
        title: '检验报告待接入',
        icon: 'none'
      });
      this.setData({
        loading: false
      });
      redirectToReportIndex();
      if (done) done();
      return;
    }

    var params = api.buildReportListParams(query, cleanKeyword);

    api.request(params).then(function(result) {
      if (result.status !== 1) {
        throw new Error(result.msg || '报告查询失败');
      }

      var reports = normalizeReports(result.list);
      var app = getApp();
      app.globalData.currentReportList = result.list || [];
      app.globalData.currentPathologyList = result.list || [];
      that.setData({
        reports: reports,
        searched: true
      });
    }).catch(function(error) {
      wx.showToast({
        title: error.message || '报告查询失败',
        icon: 'none'
      });
    }).then(function() {
      that.setData({
        loading: false
      });
      if (done) done();
    });
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
