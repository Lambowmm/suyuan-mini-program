const config = require('./config');

const AUTH_KEY = 'lisAuth';
const REFRESH_EARLY_MS = 5 * 60 * 1000;
const LIS_API_HOST = (config.LIS_API_HOST || 'https://www.suyuanbingli.cn/open').replace(/\/$/, '');
let refreshPromise = null;
let redirecting = false;

function getAuth() {
  return wx.getStorageSync(AUTH_KEY) || null;
}

function clearAuth() {
  wx.removeStorageSync(AUTH_KEY);
}

function saveAuth(data, previous) {
  if (!data || !data.token || !data.refreshToken) {
    throw new Error('检验登录响应缺少令牌');
  }
  const expiresIn = Number(data.expiresIn);
  const refreshExpiresIn = Number(data.refreshExpiresIn);
  if (data.expiresIn == null || data.refreshExpiresIn == null || !Number.isFinite(expiresIn) || !Number.isFinite(refreshExpiresIn) || expiresIn < 0 || refreshExpiresIn <= 0) {
    throw new Error('检验登录响应缺少有效的令牌过期时间');
  }
  const now = Date.now();
  const auth = {
    token: data.token,
    refreshToken: data.refreshToken,
    tokenExpireAt: now + expiresIn * 1000,
    refreshExpireAt: now + refreshExpiresIn * 1000,
    username: data.username || (previous && previous.username) || ''
  };
  wx.setStorageSync(AUTH_KEY, auth);
  return auth;
}

function rawRequest(path, method, data, token) {
  return new Promise(function(resolve, reject) {
    wx.request({
      url: LIS_API_HOST + path,
      method: method,
      data: data || {},
      header: Object.assign({ 'content-type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
      success: function(response) {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const error = new Error((response.data && (response.data.message || response.data.msg)) || '检验服务请求失败');
          error.statusCode = response.statusCode;
          reject(error);
          return;
        }
        resolve(response.data || {});
      },
      fail: reject
    });
  });
}

function login(username, password) {
  // Finish any rotation before switching accounts so it cannot overwrite this login.
  if (refreshPromise) {
    return refreshPromise.catch(function() {}).then(function() { return login(username, password); });
  }
  return rawRequest('/auth/login', 'POST', { username: username, password: password }).then(function(data) {
    redirecting = false;
    return saveAuth(data, { username: username });
  });
}

function requireLogin() {
  clearAuth();
  const pages = getCurrentPages();
  const current = pages[pages.length - 1];
  if (current && current.route !== 'pages/report/index' && !redirecting) {
    redirecting = true;
    wx.redirectTo({
      url: '/pages/report/index?mode=lis',
      complete: function() { redirecting = false; }
    });
  }
  const error = new Error('检验登录已失效，请重新登录');
  error.authExpired = true;
  throw error;
}

function refresh() {
  if (refreshPromise) return refreshPromise;
  const previous = getAuth();
  if (!previous || !previous.refreshToken || (previous.refreshExpireAt && previous.refreshExpireAt <= Date.now())) {
    return Promise.reject().catch(requireLogin);
  }
  refreshPromise = rawRequest('/auth/refresh', 'POST', { refreshToken: previous.refreshToken })
    .then(function(data) { return saveAuth(data, previous); })
    .catch(requireLogin)
    .then(function(value) { refreshPromise = null; return value; }, function(error) { refreshPromise = null; throw error; });
  return refreshPromise;
}

function readyAuth() {
  if (refreshPromise) return refreshPromise;
  const auth = getAuth();
  if (!auth || !auth.token) return Promise.reject().catch(requireLogin);
  if (auth.refreshExpireAt && auth.refreshExpireAt <= Date.now()) return Promise.reject().catch(requireLogin);
  if (auth.tokenExpireAt && auth.tokenExpireAt - Date.now() <= REFRESH_EARLY_MS) return refresh();
  return Promise.resolve(auth);
}

function withAuth(operation) {
  return readyAuth().then(function(auth) {
    return operation(auth.token).catch(function(error) {
      if (error.statusCode !== 401) throw error;
      const current = getAuth();
      const next = current && current.token !== auth.token ? Promise.resolve(current) : refresh();
      return next.then(function(updated) { return operation(updated.token); }).catch(function(retryError) {
        if (retryError.statusCode === 401) return requireLogin();
        throw retryError;
      });
    });
  });
}

function encodeQuery(params) {
  return Object.keys(params).filter(function(key) {
    return params[key] !== '' && params[key] !== undefined && params[key] !== null;
  }).map(function(key) {
    return encodeURIComponent(key) + '=' + encodeURIComponent(params[key]);
  }).join('&');
}

function request(path, params) {
  const url = path + (params ? '?' + encodeQuery(params) : '');
  return withAuth(function(token) { return rawRequest(url, 'GET', null, token); });
}

function downloadReport(id) {
  return withAuth(function(token) {
    return new Promise(function(resolve, reject) {
      wx.downloadFile({
        url: LIS_API_HOST + '/reports/' + encodeURIComponent(id) + '/pdf',
        header: { Authorization: 'Bearer ' + token },
        success: function(response) {
          if (response.statusCode === 200) return resolve(response.tempFilePath);
          const error = new Error(response.statusCode === 404 ? 'PDF 尚未就绪，请稍后再试' : '报告文件下载失败');
          error.statusCode = response.statusCode;
          reject(error);
        },
        fail: reject
      });
    });
  });
}

module.exports = { AUTH_KEY, getAuth, clearAuth, login, readyAuth, request, downloadReport };
