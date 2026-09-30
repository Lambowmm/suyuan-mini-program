const config = require('./config');
const signUtil = require('./sign');

const TOKEN_KEY = 'proc_token';
const USER_KEY = 'proc_user_info';
const LEGACY_CART_KEY = 'proc_cart_items';
const CART_KEY_PREFIX = 'proc_cart_items_u';
const CLIENT_ID_KEY = 'proc_client_id';
var identityGeneration = 0;
var cartRevision = 0;

function getClientId() {
  if (typeof wx === 'undefined' || !wx.getStorageSync) return 'mock_client_id';
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

function identityKey(user) {
  var u = normalizeUser(user);
  return u && u.userId ? String(u.userId) + ':' + (u.customerId == null ? '' : String(u.customerId)) + ':' + u.approvalStatus : '';
}

function notifyIdentityChanged() {
  if (typeof getCurrentPages !== 'function') return;
  setTimeout(function() {
    (getCurrentPages() || []).forEach(function(page) {
      if (page && typeof page.onProcurementIdentityChanged === 'function') page.onProcurementIdentityChanged();
    });
  }, 0);
}

function getToken() { return wx.getStorageSync(TOKEN_KEY) || ''; }

function setToken(token) {
  var next = token || '';
  if (getToken() !== next) identityGeneration++;
  wx.setStorageSync(TOKEN_KEY, next);
}

function getUserInfo() { return normalizeUser(wx.getStorageSync(USER_KEY) || null); }

function setUserInfo(user) {
  var previousKey = identityKey(getUserInfo());
  var normalized = normalizeUser(user);
  var nextKey = identityKey(normalized);
  wx.setStorageSync(USER_KEY, normalized);
  if (previousKey !== nextKey) {
    identityGeneration++;
    cartRevision++;
    notifyIdentityChanged();
  }
  return normalized;
}

function clearSession() {
  var hadIdentity = !!identityKey(getUserInfo()) || !!getToken();
  wx.removeStorageSync(TOKEN_KEY);
  wx.removeStorageSync(USER_KEY);
  if (hadIdentity) {
    identityGeneration++;
    cartRevision++;
    notifyIdentityChanged();
  }
}

function parseResponseData(data) {
  if (typeof data !== 'string') return data || {};
  var text = data.trim();
  if (!text) return {};
  try { return JSON.parse(text); } catch (e) { return { status: 0, msg: '服务返回格式异常' }; }
}

function request(action, params) {
  var data = Object.assign({}, params || {});
  data.action = action;
  data.timestamp = Date.now();
  var token = getToken();
  var requestGeneration = identityGeneration;
  if (token) data.token = token;
  return new Promise(function(resolve, reject) {
    wx.request({
      url: config.API_HOST,
      method: 'POST',
      data: data,
      header: { 'content-type': 'application/x-www-form-urlencoded', signature: signUtil.sign(data, config.APP_SECRET) },
      success: function(response) {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error('网络请求失败 (' + response.statusCode + ')'));
          return;
        }
        if (requestGeneration !== identityGeneration || token !== getToken()) {
          reject(new Error('登录身份已变更，请重试'));
          return;
        }
        var res = parseResponseData(response.data);
        if (res && res.status === 0 && res.msg && res.msg.indexOf('重新登录') >= 0) clearSession();
        resolve(res);
      },
      fail: reject
    });
  });
}

function login() {
  return new Promise(function(resolve, reject) {
    wx.login({
      success: function(loginRes) {
        if (!loginRes.code) { reject(new Error('获取微信登录凭证失败')); return; }
        request('proc_login', { code: loginRes.code, clientId: getClientId() })
          .then(function(res) {
            if (res.status !== 1) { reject(new Error(res.msg || '登录失败')); return; }
            setToken(res.token);
            res.user = setUserInfo(res.user);
            resolve(res);
          }).catch(reject);
      }, fail: reject
    });
  });
}

function bindPhoneNumber(options) {
  options = options || {};
  return request('proc_phone_bind', { code: options.code || '', encryptedData: options.encryptedData || '', iv: options.iv || '', phone: options.phone || '' })
    .then(function(res) { if (res.status === 1 && res.user) res.user = setUserInfo(res.user); return res; });
}

function updateAvatar(avatarUrl) {
  return request('proc_avatar_update', { avatarUrl: avatarUrl })
    .then(function(res) { if (res.status === 1 && res.user) res.user = setUserInfo(res.user); return res; });
}

function lineKey(materialId, selectedUnit) {
  return String(materialId) + '::' + encodeURIComponent(String(selectedUnit || ''));
}

function normalizeCartItem(item) {
  var copy = Object.assign({}, item || {});
  copy.lineKey = lineKey(copy.materialId, copy.selectedUnit);
  return copy;
}

function getCartScopeKey() {
  var user = getUserInfo();
  if (!getToken() || !user || !user.userId || !user.customerId) return '';
  return CART_KEY_PREFIX + String(user.userId) + '_c' + String(user.customerId);
}

function discardLegacyCart() {
  if (wx.getStorageSync(LEGACY_CART_KEY)) wx.removeStorageSync(LEGACY_CART_KEY);
}

function getCartContext() {
  return { scopeKey: getCartScopeKey(), revision: cartRevision, identityGeneration: identityGeneration };
}

function isCartContextCurrent(context) {
  return !!context && context.scopeKey === getCartScopeKey() && context.revision === cartRevision && context.identityGeneration === identityGeneration;
}

function getCart() {
  discardLegacyCart();
  var key = getCartScopeKey();
  if (!key) return [];
  var stored = wx.getStorageSync(key);
  return Array.isArray(stored) ? stored.map(normalizeCartItem) : [];
}

function saveCart(cart, expectedContext) {
  discardLegacyCart();
  var key = getCartScopeKey();
  if (!key) return [];
  if (expectedContext && !isCartContextCurrent(expectedContext)) return null;
  var normalized = (Array.isArray(cart) ? cart : []).map(normalizeCartItem);
  wx.setStorageSync(key, normalized);
  cartRevision++;
  return normalized;
}

function addToCart(item) {
  var cart = getCart();
  if (!getCartScopeKey()) return cart;
  var found = false;
  for (var i = 0; i < cart.length; i++) {
    if (cart[i].materialId === item.materialId && cart[i].selectedUnit === item.selectedUnit) {
      cart[i].selectedQty += item.selectedQty;
      found = true;
      break;
    }
  }
  if (!found) cart.push(normalizeCartItem(item));
  return saveCart(cart) || [];
}

function updateCartQty(materialId, selectedUnit, qty) {
  var cart = getCart();
  var filtered = [];
  for (var i = 0; i < cart.length; i++) {
    if (cart[i].materialId === materialId && cart[i].selectedUnit === selectedUnit) {
      if (qty > 0) { cart[i].selectedQty = qty; filtered.push(cart[i]); }
    } else filtered.push(cart[i]);
  }
  return saveCart(filtered) || [];
}

function clearCart() {
  discardLegacyCart();
  var key = getCartScopeKey();
  if (key) wx.removeStorageSync(key);
  cartRevision++;
}

function getApprovalStatusKey(user) {
  var u = normalizeUser(user || getUserInfo());
  return u && u.userId ? 'proc_last_approval_status_u' + u.userId : '';
}

function formatMoney(num) { return '¥' + (Number(num) || 0).toFixed(2); }

module.exports = {
  getToken: getToken, setToken: setToken, getUserInfo: getUserInfo, setUserInfo: setUserInfo,
  clearSession: clearSession, request: request, login: login, bindPhoneNumber: bindPhoneNumber,
  updateAvatar: updateAvatar, normalizeUser: normalizeUser, getClientId: getClientId,
  getCart: getCart, saveCart: saveCart, addToCart: addToCart, updateCartQty: updateCartQty,
  clearCart: clearCart, getCartContext: getCartContext, isCartContextCurrent: isCartContextCurrent,
  getCartScopeKey: getCartScopeKey, getApprovalStatusKey: getApprovalStatusKey,
  lineKey: lineKey, formatMoney: formatMoney
};
