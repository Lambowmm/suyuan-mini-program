const config = require('./config');
const signUtil = require('./sign');

function getStoredUser() {
  return wx.getStorageSync('userInfo') || null;
}

function getStoredUid() {
  var userInfo = getStoredUser();
  return userInfo && userInfo.uid ? userInfo.uid : '';
}

function parseResponseData(data) {
  if (typeof data !== 'string') {
    return data || {};
  }

  var text = data.trim();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    return {
      status: 0,
      msg: '服务返回格式异常'
    };
  }
}

function request(params) {
  var data = Object.assign({}, params || {});

  if (data.action !== 'getuserinfo' && !data.uid) {
    data.uid = getStoredUid();
  }

  data.timestamp = Date.now();

  return new Promise(function(resolve, reject) {
    wx.request({
      url: config.API_HOST,
      method: 'POST',
      data: data,
      header: {
        'content-type': 'application/x-www-form-urlencoded',
        signature: signUtil.sign(data, config.APP_SECRET)
      },
      success: function(response) {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error('网络请求失败，请稍后重试'));
          return;
        }
        resolve(parseResponseData(response.data));
      },
      fail: function(error) {
        reject(error);
      }
    });
  });
}

function buildReportListParams(query, keyword) {
  var params = {
    action: 'reportList',
    sendHospital: query.sendHospital,
    password: query.password,
    regeditTime: query.regeditTime,
    regeditEndTime: query.regeditEndTime
  };

  if (keyword) {
    params.checkType = keyword;
    params.patientName = keyword;
    params.sendOffice = keyword;
  }

  return params;
}

module.exports = {
  request: request,
  buildReportListParams: buildReportListParams
};
