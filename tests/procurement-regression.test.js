const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

function runSource(file, globals, dependencies) {
  const sandbox = Object.assign({ module: { exports: {} }, console, Promise, setTimeout, clearTimeout,
    require: name => dependencies[name] }, globals || {});
  vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox, { filename: file });
  return sandbox.module.exports;
}

function storageWx(initial) {
  const values = new Map(Object.entries(initial || {}));
  return {
    values,
    getStorageSync: key => values.get(key),
    setStorageSync: (key, value) => values.set(key, value),
    removeStorageSync: key => values.delete(key)
  };
}

function loadProcurement(wx, getCurrentPages) {
  return runSource('utils/procurement.js', { wx, getCurrentPages: getCurrentPages || (() => []) }, {
    './config': { API_HOST: '/api', APP_SECRET: 'secret' }, './sign': { sign: () => 'sig' }
  });
}

function loadPage(file, procurement, wx) {
  let definition;
  runSource(file, { wx, Page: value => { definition = value; } }, { '../../utils/procurement': procurement });
  const page = Object.assign({}, definition);
  page.data = JSON.parse(JSON.stringify(definition.data));
  page.setData = function(update) { Object.assign(this.data, update); };
  return page;
}

test('real procurement utility scopes cart by logged-in user and hospital and discards legacy cart', () => {
  const wx = storageWx({ proc_cart_items: [{ materialId: 999, selectedUnit: '旧单位', selectedQty: 1 }] });
  const proc = loadProcurement(wx);
  proc.setToken('token');
  proc.setUserInfo({ UserId: 1, CustomerId: 10, ApprovalStatus: 'APPROVED' });
  proc.addToCart({ materialId: 7, selectedUnit: '盒', selectedQty: 1 });
  proc.addToCart({ materialId: 7, selectedUnit: '盒（赠品）', selectedQty: 2 });
  assert.equal(proc.getCart().length, 2);
  assert.notEqual(proc.getCart()[0].lineKey, proc.getCart()[1].lineKey);
  assert.equal(wx.values.has('proc_cart_items'), false);

  proc.setUserInfo({ userId: 2, customerId: 10, approvalStatus: 'APPROVED' });
  assert.deepEqual(Array.from(proc.getCart()), []);
  proc.addToCart({ materialId: 8, selectedUnit: '箱', selectedQty: 1 });
  proc.setUserInfo({ userId: 1, customerId: 11, approvalStatus: 'APPROVED' });
  assert.equal(proc.getCart().length, 0);
  proc.setUserInfo({ userId: 1, customerId: 10, approvalStatus: 'APPROVED' });
  assert.equal(proc.getCart().length, 2);

  proc.clearSession();
  assert.equal(proc.getCart().length, 0);
  proc.setToken('new-token');
  proc.setUserInfo({ userId: 1, customerId: 10, approvalStatus: 'APPROVED' });
  assert.equal(proc.getCart().length, 2);
});

test('real procurement request rejects a response from an old identity without clearing the new session', async () => {
  const wx = storageWx();
  let pending;
  wx.request = options => { pending = options; };
  const proc = loadProcurement(wx);
  proc.setToken('token-a');
  proc.setUserInfo({ userId: 1, customerId: 10, approvalStatus: 'APPROVED' });
  const request = proc.request('proc_profile');
  proc.setToken('token-b');
  proc.setUserInfo({ userId: 2, customerId: 20, approvalStatus: 'APPROVED' });
  pending.success({ statusCode: 200, data: { status: 0, msg: '请重新登录' } });
  await assert.rejects(request, /登录身份已变更/);
  assert.equal(proc.getToken(), 'token-b');
  assert.equal(proc.getUserInfo().userId, 2);
});

test('real mine page reads and writes approval transition markers per user', async () => {
  const wx = storageWx({ proc_last_approval_status_u1: 'PENDING' });
  const modals = [];
  Object.assign(wx, { showModal: value => modals.push(value), switchTab() {} });
  let current = { userId: 2, customerId: 20, approvalStatus: 'APPROVED', customerName: '乙医院' };
  const procurement = {
    getToken: () => 'token', request: () => Promise.resolve({ status: 1, user: current }),
    setUserInfo: user => user, getApprovalStatusKey: user => 'proc_last_approval_status_u' + user.userId
  };
  const page = loadPage('pages/mine/index.js', procurement, wx);
  await page.refreshUserInfo(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(modals.length, 0);
  assert.equal(wx.getStorageSync('proc_last_approval_status_u2'), 'APPROVED');
  current = { userId: 1, customerId: 10, approvalStatus: 'APPROVED', customerName: '甲医院' };
  await page.refreshUserInfo(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(modals.length, 1);
  assert.equal(wx.getStorageSync('proc_last_approval_status_u1'), 'APPROVED');
  assert.equal(wx.getStorageSync('proc_last_approval_status'), undefined);
  page.onUnload();
});

test('real order page uses normalized PascalCase profile fields for approval checks', async () => {
  const normalized = { userId: 5, customerId: 30, customerName: '规范医院', approvalStatus: 'APPROVED' };
  const procurement = {
    request: action => Promise.resolve(action === 'proc_profile' ? { status: 1, user: { UserId: 5, CustomerId: 30, CustomerName: '规范医院', ApprovalStatus: 'APPROVED' } } : { status: 1, list: [], categories: [] }),
    setUserInfo: () => normalized, getCart: () => []
  };
  const page = loadPage('pages/order/index.js', procurement, {});
  await page.checkAuthAndLoad();
  assert.equal(page.data.isApproved, true);
  assert.equal(page.data.hospitalName, '规范医院');
});

test('real cart page fails closed on business and network validation errors while retaining items', async () => {
  const item = { materialId: 1, selectedUnit: '盒', selectedQty: 2, lineKey: '1::box', packageUnitPrice: '9.00', lineAmount: '18.00' };
  let mode = 'business';
  const context = { scopeKey: 'scope', revision: 1, identityGeneration: 1 };
  const procurement = {
    getCart: () => [Object.assign({}, item)], getCartContext: () => context,
    isCartContextCurrent: () => true,
    request: () => mode === 'network' ? Promise.reject(new Error('断网')) : Promise.resolve({ status: 0, msg: '价格服务异常' }),
    lineKey: () => item.lineKey, saveCart: () => { throw new Error('failed validation must not save'); }
  };
  const page = loadPage('pages/order/cart.js', procurement, { showToast() {} });
  await page.loadAndValidateCart();
  assert.equal(page.data.items.length, 1);
  assert.equal(page.data.canCheckout, false);
  assert.match(page.data.validationMessage, /价格服务异常/);
  mode = 'network';
  await page.loadAndValidateCart();
  assert.equal(page.data.items.length, 1);
  assert.equal(page.data.canCheckout, false);
  assert.match(page.data.validationMessage, /断网/);
});

test('real cart page ignores an older validation response after a quantity edit', async () => {
  let revision = 1;
  let stored = [{ materialId: 1, selectedUnit: '盒', selectedQty: 1, lineKey: '1::box' }];
  const pending = [];
  const procurement = {
    getCart: () => stored.map(item => Object.assign({}, item)),
    getCartContext: () => ({ scopeKey: 'scope', revision, identityGeneration: 1 }),
    isCartContextCurrent: context => context.revision === revision,
    request: () => new Promise(resolve => pending.push(resolve)),
    lineKey: () => '1::box',
    saveCart: (items, context) => { if (context.revision !== revision) return null; stored = items; revision++; return items; }
  };
  const page = loadPage('pages/order/cart.js', procurement, { showToast() {} });
  const first = page.loadAndValidateCart();
  stored[0].selectedQty = 2; revision++;
  const second = page.loadAndValidateCart();
  pending[1]({ status: 1, totalAmount: 18, items: [{ materialId: 1, selectedUnit: '盒', selectedQty: 2, factorToBase: 10, packageUnitPrice: 9, lineAmount: 18 }] });
  await second;
  pending[0]({ status: 1, totalAmount: 9, items: [{ materialId: 1, selectedUnit: '盒', selectedQty: 1, factorToBase: 10, packageUnitPrice: 9, lineAmount: 9 }] });
  await first;
  assert.equal(page.data.items[0].selectedQty, 2);
  assert.equal(page.data.totalAmount, '18.00');
});

test('real checkout page uses authoritative line and total amounts and preserves ambiguous retry payload/key', async () => {
  const local = { materialId: 1, selectedUnit: '盒', selectedQty: 2, factorToBase: 10,
    packageUnitPrice: '10.00', lineAmount: '20.00', lineKey: '1::box' };
  let revision = 1;
  let submitCalls = [];
  let validationCalls = 0;
  let submitReject = true;
  const procurement = {
    getCart: () => [Object.assign({}, local)],
    getCartContext: () => ({ scopeKey: 'scope', revision, identityGeneration: 1 }),
    isCartContextCurrent: context => context.scopeKey === 'scope' && context.revision === revision,
    lineKey: () => '1::box', saveCart: () => { revision++; return [local]; }, clearCart() {},
    request: (action, params) => {
      if (action === 'proc_cart_validate') { validationCalls++; return Promise.resolve({ status: 1, totalAmount: 19.99, items: [{ materialId: 1, selectedUnit: '盒', selectedQty: 2, factorToBase: 10, packageUnitPrice: 10, lineAmount: 19.99 }] }); }
      if (action === 'proc_order_submit') { submitCalls.push(params); return submitReject ? Promise.reject(new Error('timeout')) : Promise.resolve({ status: 1, orderNo: 'O1', orderId: 1, totalAmount: 19.99 }); }
      return Promise.resolve({ status: 1, list: [] });
    }
  };
  const wx = { showLoading() {}, hideLoading() {}, showModal() {}, showToast() {} };
  const page = loadPage('pages/order/checkout.js', procurement, wx);
  page.initIdempotencyKey();
  await page.validateCart(false);
  assert.equal(page.data.totalAmount, '19.99');
  assert.equal(page.data.items[0].lineAmount, '19.99');
  page.setData({ selectedAddress: { id: 9 }, remarks: '原备注' });
  page.submitOrder();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(validationCalls, 2);
  assert.equal(page.data.showConfirmModal, true);
  page.executeSubmit();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(page.data.submissionUncertain, true);
  const first = submitCalls[0];
  page.setData({ showConfirmModal: true });
  submitReject = false;
  page.executeSubmit();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(submitCalls[1].idempotencyKey, first.idempotencyKey);
  assert.equal(submitCalls[1].items, first.items);
  assert.equal(page.data.orderSubmitted, true);
});

test('real checkout blocks direct-entry submit after validation failure', async () => {
  let submitCount = 0;
  const context = { scopeKey: 'scope', revision: 1, identityGeneration: 1 };
  const procurement = {
    getCart: () => [{ materialId: 1, selectedUnit: '盒', selectedQty: 1, lineKey: '1::box' }],
    getCartContext: () => context, isCartContextCurrent: () => true,
    request: action => { if (action === 'proc_order_submit') submitCount++; return Promise.resolve({ status: 0, msg: '验价服务不可用' }); }
  };
  const page = loadPage('pages/order/checkout.js', procurement, { showModal() {}, showLoading() {}, hideLoading() {} });
  page.setData({ selectedAddress: { id: 1 } });
  await page.validateCart(false);
  page.submitOrder();
  await new Promise(resolve => setTimeout(resolve, 0));
  page.executeSubmit();
  assert.equal(page.data.canSubmit, false);
  assert.equal(page.data.showConfirmModal, false);
  assert.equal(submitCount, 0);
});

test('real checkout quote change reloads for reconfirmation and stale-account submit callback cannot create pending retry', async () => {
  let identity = 1;
  let submitMode = 'quote';
  let rejectSubmit;
  let submitCount = 0;
  let revision = 1;
  const item = { materialId: 1, selectedUnit: '盒', selectedQty: 1, factorToBase: 10, packageUnitPrice: '10.00', lineAmount: '10.00', lineKey: '1::box' };
  const procurement = {
    getCart: () => [Object.assign({}, item)],
    getCartContext: () => ({ scopeKey: 'scope-' + identity, revision, identityGeneration: identity }),
    isCartContextCurrent: context => context.scopeKey === 'scope-' + identity && context.revision === revision,
    lineKey: () => item.lineKey, saveCart: items => { revision++; return items; }, clearCart() {},
    request: action => {
      if (action === 'proc_cart_validate') return Promise.resolve({ status: 1, totalAmount: 10, items: [item] });
      if (action === 'proc_order_submit') {
        submitCount++;
        if (submitMode === 'quote') return Promise.resolve({ status: 0, code: 'QUOTE_CHANGED', msg: '价格变化' });
        return new Promise((resolve, reject) => { rejectSubmit = reject; });
      }
      return Promise.resolve({ status: 1, list: [] });
    }
  };
  const page = loadPage('pages/order/checkout.js', procurement, { showModal() {}, showLoading() {}, hideLoading() {} });
  page.setData({ items: [item], totalAmount: '10.00', totalQty: 1, selectedAddress: { id: 1 }, canSubmit: true, validationStatus: 'valid', idempotencyKey: 'same-key' });
  page._validatedContext = procurement.getCartContext();
  page.executeSubmit();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(submitCount, 1);
  assert.equal(page.data.orderSubmitted, false);
  assert.equal(page.data.showConfirmModal, false);

  submitMode = 'pending';
  page.setData({ canSubmit: true, validationStatus: 'valid', submitting: false });
  page._validatedContext = procurement.getCartContext();
  page.executeSubmit();
  identity = 2;
  rejectSubmit(new Error('late failure'));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(page._ambiguousSubmission, null);
  assert.equal(page.data.submissionUncertain, false);
});

test('real checkout identity change clears the previous account success state and validates the new cart', async () => {
  let revision = 1;
  const item = { materialId: 2, selectedUnit: '箱', selectedQty: 1, factorToBase: 20,
    packageUnitPrice: '30.00', lineAmount: '30.00', lineKey: '2::box' };
  const procurement = {
    getCart: () => [Object.assign({}, item)],
    getCartContext: () => ({ scopeKey: 'user-b', revision, identityGeneration: 2 }),
    isCartContextCurrent: context => context.scopeKey === 'user-b' && context.revision === revision,
    lineKey: () => item.lineKey,
    saveCart: items => { revision++; return items; },
    request: action => action === 'proc_cart_validate'
      ? Promise.resolve({ status: 1, totalAmount: 30, items: [item] })
      : Promise.resolve({ status: 1, list: [{ id: 22, isDefault: true }] })
  };
  const page = loadPage('pages/order/checkout.js', procurement, { showToast() {} });
  page.setData({ orderSubmitted: true, submittedOrderNo: 'A-ORDER', submittedOrderId: 11,
    submittedAmount: '88.00', showSuccessModal: true, showConfirmModal: true,
    quoteChanged: true, remarks: 'A账号备注', submissionUncertain: true });
  page._ambiguousSubmission = { params: { idempotencyKey: 'a-key' } };
  page.onProcurementIdentityChanged();
  assert.equal(page.data.orderSubmitted, false);
  assert.equal(page.data.submittedOrderNo, '');
  assert.equal(page.data.submittedOrderId, 0);
  assert.equal(page.data.submittedAmount, '0.00');
  assert.equal(page.data.showSuccessModal, false);
  assert.equal(page.data.showConfirmModal, false);
  assert.equal(page.data.remarks, '');
  assert.equal(page._ambiguousSubmission, null);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(page.data.items[0].materialId, 2);
  assert.equal(page.data.totalAmount, '30.00');
  assert.equal(page.data.canSubmit, true);
  assert.equal(page.data.selectedAddress.id, 22);
});

