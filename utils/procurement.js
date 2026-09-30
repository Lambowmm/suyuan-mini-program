const config = require('./config');
const signUtil = require('./sign');

const TOKEN_KEY = 'proc_token';
const USER_KEY = 'proc_user_info';
const CART_KEY = 'proc_cart_items';
const CLIENT_ID_KEY = 'proc_client_id';

function getClientId() {
  if (typeof wx === 'undefined' || !wx.getStorageSync) {
    return 'mock_client_id';
  }
  var cid = wx.getStorageSync(CLIENT_ID_KEY);
  if (!cid) {
    cid = 'c_' + Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
    wx.setStorageSync(CLIENT_ID_KEY, cid);
  }
  return cid;
}

function normalizeUser(user) {
  if (!user || typeof user !== 'object') return null;
  var u = Object.assign({}, user);
  u.approvalStatus = (u.approvalStatus || u.ApprovalStatus || 'UNAPPLIED').toUpperCase();
  u.phone = u.phone || u.Phone || '';
  u.realName = u.realName || u.RealName || '';
  u.department = u.department || u.Department || '';
  u.applyHospitalName = u.applyHospitalName || u.ApplyHospitalName || '';
  u.customerId = u.customerId != null ? u.customerId : (u.CustomerId != null ? u.CustomerId : null);
  u.customerName = u.customerName || u.CustomerName || '';
  u.rejectReason = u.rejectReason || u.RejectReason || '';
  u.avatarUrl = u.avatarUrl || u.AvatarUrl || '';
  u.userId = u.userId || u.UserId || 0;
  u.openid = u.openid || u.OpenId || '';
  u.isApproved = (u.approvalStatus === 'APPROVED' && !!u.customerId);
  return u;
}

function getToken() {
  return wx.getStorageSync(TOKEN_KEY) || '';
}

function setToken(token) {
  wx.setStorageSync(TOKEN_KEY, token || '');
}

function getUserInfo() {
  return normalizeUser(wx.getStorageSync(USER_KEY) || null);
}

function setUserInfo(user) {
  var normalized = normalizeUser(user);
  wx.setStorageSync(USER_KEY, normalized);
  return normalized;
}

function clearSession() {
  wx.removeStorageSync(TOKEN_KEY);
  wx.removeStorageSync(USER_KEY);
}

function parseResponseData(data) {
  if (typeof data !== 'string') return data || {};
  var text = data.trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (e) {
    return { status: 0, msg: '服务返回格式异常' };
  }
}

function request(action, params) {
  var data = Object.assign({}, params || {});
  data.action = action;
  data.timestamp = Date.now();

  var token = getToken();
  if (token) {
    data.token = token;
  }

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
          reject(new Error('网络请求失败 (' + response.statusCode + ')'));
          return;
        }
        var res = parseResponseData(response.data);
        if (res && res.status === 0 && res.msg && res.msg.indexOf('重新登录') >= 0) {
          clearSession();
        }
        resolve(res);
      },
      fail: function(err) {
        reject(err);
      }
    });
  });
}

function login() {
  return new Promise(function(resolve, reject) {
    wx.login({
      success: function(loginRes) {
        if (!loginRes.code) {
          reject(new Error('获取微信登录凭证失败'));
          return;
        }
        request('proc_login', {
          code: loginRes.code,
          clientId: getClientId()
        })
          .then(function(res) {
            if (res.status === 1) {
              setToken(res.token);
              var u = setUserInfo(res.user);
              res.user = u;
              resolve(res);
            } else {
              reject(new Error(res.msg || '登录失败'));
            }
          })
          .catch(reject);
      },
      fail: reject
    });
  });
}

function bindPhoneNumber(options) {
  options = options || {};
  return request('proc_phone_bind', {
    code: options.code || '',
    encryptedData: options.encryptedData || '',
    iv: options.iv || '',
    phone: options.phone || ''
  }).then(function(res) {
    if (res.status === 1 && res.user) {
      setUserInfo(res.user);
    }
    return res;
  });
}

function updateAvatar(avatarUrl) {
  return request('proc_avatar_update', { avatarUrl: avatarUrl })
    .then(function(res) {
      if (res.status === 1 && res.user) {
        setUserInfo(res.user);
      }
      return res;
    });
}

function getCart() {
  return wx.getStorageSync(CART_KEY) || [];
}

function saveCart(cart) {
  wx.setStorageSync(CART_KEY, cart || []);
}

function addToCart(item) {
  var cart = getCart();
  var found = false;
  for (var i = 0; i < cart.length; i++) {
    if (cart[i].materialId === item.materialId && cart[i].selectedUnit === item.selectedUnit) {
      cart[i].selectedQty += item.selectedQty;
      found = true;
      break;
    }
  }
  if (!found) {
    cart.push(item);
  }
  saveCart(cart);
  return cart;
}

function updateCartQty(materialId, selectedUnit, qty) {
  var cart = getCart();
  var filtered = [];
  for (var i = 0; i < cart.length; i++) {
    if (cart[i].materialId === materialId && cart[i].selectedUnit === selectedUnit) {
      if (qty > 0) {
        cart[i].selectedQty = qty;
        filtered.push(cart[i]);
      }
    } else {
      filtered.push(cart[i]);
    }
  }
  saveCart(filtered);
  return filtered;
}

function clearCart() {
  wx.removeStorageSync(CART_KEY);
}

function formatMoney(num) {
  var n = Number(num) || 0;
  return '¥' + n.toFixed(2);
}

module.exports = {
  getToken: getToken,
  setToken: setToken,
  getUserInfo: getUserInfo,
  setUserInfo: setUserInfo,
  clearSession: clearSession,
  request: request,
  login: login,
  bindPhoneNumber: bindPhoneNumber,
  updateAvatar: updateAvatar,
  normalizeUser: normalizeUser,
  getClientId: getClientId,
  getCart: getCart,
  saveCart: saveCart,
  addToCart: addToCart,
  updateCartQty: updateCartQty,
  clearCart: clearCart,
  formatMoney: formatMoney
};
