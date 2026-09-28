const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const authData = (suffix = '1') => ({ token: 'token-' + suffix, refreshToken: 'refresh-' + suffix, expiresIn: 28800, refreshExpiresIn: 2592000 });
const storedAuth = (extra = {}) => Object.assign({ token: 'old', refreshToken: 'old-refresh', tokenExpireAt: Date.now() + 3600000, refreshExpireAt: Date.now() + 86400000, username: 'test-org' }, extra);

function loadModule(file, context, dependencies) {
  const sandbox = Object.assign({ module: { exports: {} }, require: name => dependencies[name], console, setTimeout, clearTimeout }, context);
  vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox, { filename: file });
  return sandbox.module.exports;
}

function authHarness(initial) {
  const storage = initial || {};
  const calls = [];
  const redirects = [];
  const wx = {
    getStorageSync: key => storage[key],
    setStorageSync: (key, value) => { storage[key] = value; },
    removeStorageSync: key => { delete storage[key]; },
    request: options => calls.push(options),
    downloadFile: options => calls.push(options),
    redirectTo: options => { redirects.push(options.url); }
  };
  const lis = loadModule('utils/lis.js', { wx, getCurrentPages: () => [{ route: 'pages/report/result' }] }, { './config': { LIS_API_HOST: 'https://example.test/open/' } });
  return { lis, storage, calls, redirects };
}

function reply(call, data, statusCode = 200) { call.success({ statusCode, data, tempFilePath: '/tmp/report.pdf' }); }

function pageHarness(file, lis, globalData = {}) {
  let definition;
  const notices = [];
  const navigation = [];
  const scrolls = [];
  const wx = {
    showToast: value => notices.push(value.title),
    setNavigationBarTitle() {}, stopPullDownRefresh() {},
    navigateTo: value => navigation.push(value.url),
    getStorageSync() { return ''; }, setStorageSync() {},
    openDocument() {}, pageScrollTo: options => scrolls.push(options)
  };
  const app = { globalData };
  const legacy = { buildReportListParams: query => query, request: () => Promise.resolve({ status: 1, list: [] }) };
  loadModule(file, { Page: value => { definition = value; }, wx, getApp: () => app }, {
    '../../utils/lis': lis,
    '../../utils/api': legacy,
    '../../utils/report-order': require('../utils/report-order'),
    '../../utils/date': { defaultRange: () => ({ today: '2026-09-26', start: '2026-08-27', end: '2026-09-26' }), compareDate: (a, b) => a.localeCompare(b) }
  });
  const page = Object.assign({}, definition, { data: JSON.parse(JSON.stringify(definition.data)), updates: [] });
  page.setData = function(update, callback) {
    this.updates.push(JSON.parse(JSON.stringify(update)));
    for (const [key, value] of Object.entries(update)) {
      const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.');
      let target = this.data;
      parts.slice(0, -1).forEach(part => { target = target[part]; });
      target[parts[parts.length - 1]] = value;
    }
  };
  const setData = page.setData;
  page.setData = function(update, callback) { setData.call(this, update); if (callback) callback(); };
  return { page, app, notices, navigation, legacy, scrolls };
}

const query = { reportKind: 'lis', regeditTime: '2026-07-28', regeditEndTime: '2026-08-27' };

test('login persists only rotating credentials and absolute expiries; restart reuses them', async () => {
  const h = authHarness();
  const before = Date.now();
  const pending = h.lis.login('test-org', 'transient-password');
  reply(h.calls[0], authData());
  await pending;
  const auth = h.storage.lisAuth;
  assert.deepEqual(Object.keys(auth).sort(), ['refreshExpireAt', 'refreshToken', 'token', 'tokenExpireAt', 'username'].sort());
  assert.ok(auth.tokenExpireAt >= before + 28800000);
  assert.ok(auth.refreshExpireAt >= before + 2592000000);
  assert.ok(!JSON.stringify(h.storage).includes('transient-password'));
  const restarted = authHarness(h.storage);
  const request = restarted.lis.request('/reports');
  await tick();
  assert.equal(restarted.calls.length, 1);
  assert.equal(restarted.calls[0].header.Authorization, 'Bearer token-1');
  reply(restarted.calls[0], { total: 0, items: [] });
  await request;
});

test('concurrent near-expiry requests share one refresh and atomically replace both tokens', async () => {
  const h = authHarness({ lisAuth: storedAuth({ tokenExpireAt: Date.now() + 1000 }) });
  const a = h.lis.request('/reports');
  const b = h.lis.request('/reports/stats');
  assert.equal(h.calls.length, 1);
  assert.ok(h.calls[0].url.endsWith('/auth/refresh'));
  assert.equal(h.calls[0].data.refreshToken, 'old-refresh');
  reply(h.calls[0], authData('rotated'));
  await tick();
  assert.equal(h.storage.lisAuth.refreshToken, 'refresh-rotated');
  assert.equal(h.calls.length, 3);
  h.calls.slice(1).forEach(call => { assert.equal(call.header.Authorization, 'Bearer token-rotated'); reply(call, {}); });
  await Promise.all([a, b]);
});

test('unknown expiry sends request first; late concurrent 401 reuses the already rotated pair', async () => {
  const h = authHarness({ lisAuth: storedAuth({ tokenExpireAt: 0 }) });
  const a = h.lis.request('/reports');
  const b = h.lis.request('/reports/stats');
  await tick();
  reply(h.calls[0], {}, 401);
  await tick();
  reply(h.calls[2], authData('new'));
  await tick();
  reply(h.calls[3], {});
  reply(h.calls[1], {}, 401);
  await tick();
  assert.equal(h.calls.filter(call => call.url.endsWith('/auth/refresh')).length, 1);
  assert.equal(h.calls[4].header.Authorization, 'Bearer token-new');
  reply(h.calls[4], {});
  await Promise.all([a, b]);
});

test('a second 401 stops retrying and clears authentication', async () => {
  const h = authHarness({ lisAuth: storedAuth() });
  const request = h.lis.request('/reports');
  const rejected = assert.rejects(request, error => error.authExpired);
  await tick();
  reply(h.calls[0], {}, 401);
  await tick();
  reply(h.calls[1], authData('new'));
  await tick();
  reply(h.calls[2], {}, 401);
  await rejected;
  assert.equal(h.calls.length, 3);
  assert.equal(h.storage.lisAuth, undefined);
  assert.equal(h.redirects[0], '/pages/report/index?mode=lis');
});

test('expired refresh token or failed refresh requires login', async () => {
  const expired = authHarness({ lisAuth: storedAuth({ refreshExpireAt: Date.now() - 1 }) });
  await assert.rejects(expired.lis.request('/reports'), error => error.authExpired);
  assert.equal(expired.calls.length, 0);
  assert.equal(expired.storage.lisAuth, undefined);
  const failed = authHarness({ lisAuth: storedAuth({ tokenExpireAt: Date.now() - 1 }) });
  const request = failed.lis.request('/reports');
  const rejected = assert.rejects(request, error => error.authExpired);
  reply(failed.calls[0], {}, 401);
  await rejected;
  assert.equal(failed.storage.lisAuth, undefined);
});

test('PDF uses the portal id and shares 401 refresh; 404 reports PDF pending', async () => {
  const h = authHarness({ lisAuth: storedAuth() });
  const request = h.lis.downloadReport('portal/id');
  await tick();
  assert.ok(h.calls[0].url.endsWith('/reports/portal%2Fid/pdf'));
  reply(h.calls[0], {}, 401);
  await tick();
  reply(h.calls[1], authData('new'));
  await tick();
  reply(h.calls[2], {});
  assert.equal(await request, '/tmp/report.pdf');
  const missing = h.lis.downloadReport(10);
  const rejected = assert.rejects(missing, /PDF 尚未就绪/);
  await tick();
  reply(h.calls[3], {}, 404);
  await rejected;
});

test('LIS query navigation carries no password; saved login hides password after restart', async () => {
  let saved = null;
  const lis = { getAuth: () => saved, readyAuth: () => Promise.resolve(saved), login: async (username, password) => {
    assert.equal(password, 'temporary'); saved = storedAuth({ username }); return saved;
  } };
  const h = pageHarness('pages/report/index.js', lis);
  h.page.onLoad({ mode: 'lis' });
  h.page.data.query.sendHospital = 'test-org';
  h.page.data.query.password = 'temporary';
  h.page.submitQuery();
  await tick();
  assert.equal(h.app.globalData.currentReportQuery.password, undefined);
  assert.equal(h.page.data.query.password, '');
  assert.equal(h.navigation[0], '/pages/report/result');
  const reopened = pageHarness('pages/report/index.js', lis);
  reopened.page.onLoad({});
  await tick();
  assert.equal(reopened.page.data.mode, 'lis');
  assert.equal(reopened.page.data.lisSignedIn, true);
  assert.equal(reopened.page.validateQuery(), '');
});

test('pathology list still uses legacy normalization and pending PDF does not request a file', () => {
  let downloads = 0;
  const lis = { downloadReport: () => { downloads++; return Promise.resolve('file'); } };
  const h = pageHarness('pages/report/result.js', lis, { currentReportQuery: { reportKind: 'pathology' }, currentReportList: [{ ReportID: 'pathology-1', PatientName: '病理患者', ReportType: '免疫组化' }] });
  h.page.onLoad();
  assert.equal(h.page.data.reports[0]._typeTag, '免');
  h.page.openLisReport({ id: 1, ReportID: 1, syncStatus: 'pending_pdf' }, false);
  assert.equal(downloads, 0);
  assert.match(h.notices[0], /PDF 尚未就绪/);
});

test('switching accounts waits for an in-flight rotation before saving the new session', async () => {
  const h = authHarness({ lisAuth: storedAuth({ tokenExpireAt: Date.now() - 1 }) });
  const restore = h.lis.readyAuth();
  const login = h.lis.login('new-org', 'temporary');
  assert.equal(h.calls.length, 1);
  reply(h.calls[0], authData('rotated'));
  await restore;
  await tick();
  assert.ok(h.calls[1].url.endsWith('/auth/login'));
  reply(h.calls[1], authData('new-org'));
  await login;
  assert.equal(h.storage.lisAuth.username, 'new-org');
  assert.equal(h.storage.lisAuth.token, 'token-new-org');
});

test('legacy parameter builder preserves pathology and rejects the obsolete LIS password route', () => {
  const api = loadModule('utils/api.js', {}, { './config': {}, './sign': {} });
  const params = api.buildReportListParams({ reportKind: 'pathology', sendHospital: 'hospital', password: 'runtime-only', regeditTime: '2026-07-28', regeditEndTime: '2026-08-27' }, 'keyword');
  assert.equal(params.action, 'reportList');
  assert.equal(params.patientName, 'keyword');
  assert.equal(params.password, 'runtime-only');
  assert.throws(() => api.buildReportListParams({ reportKind: 'lis' }), /LIS/);
});

test('account drafts are isolated and ambiguous legacy account storage is not reused', () => {
  const h = pageHarness('pages/report/index.js', { getAuth: () => null });
  h.page.onLoad({});
  h.page.onInput({ currentTarget: { dataset: { field: 'sendHospital' } }, detail: { value: 'pathology-only' } });
  h.page.setMode({ currentTarget: { dataset: { mode: 'lis' } } });
  assert.equal(h.page.data.query.sendHospital, '');
  h.page.onInput({ currentTarget: { dataset: { field: 'sendHospital' } }, detail: { value: 'lis-only' } });
  h.page.setMode({ currentTarget: { dataset: { mode: 'pathology' } } });
  assert.equal(h.page.data.query.sendHospital, 'pathology-only');
  h.page.setMode({ currentTarget: { dataset: { mode: 'lis' } } });
  assert.equal(h.page.data.query.sendHospital, 'lis-only');
});

test('ascending order produces full 30-item pages from descending API pages including a partial tail', async () => {
  const { ascendingPager } = require('../utils/report-order');
  const all = Array.from({ length: 71 }, (_, i) => ({ id: 71 - i }));
  const calls = [];
  const read = ascendingPager(async (url, params) => {
    calls.push(params.page);
    return { total: all.length, items: all.slice((params.page - 1) * params.pageSize, params.page * params.pageSize) };
  }, { pageSize: 30 });
  const first = await read(1);
  assert.equal(first.items.length, 30);
  assert.deepEqual(first.items.map(item => item.id), Array.from({ length: 30 }, (_, i) => i + 1));
  const second = await read(2);
  const third = await read(3);
  assert.equal(third.items.length, 11);
  assert.deepEqual(first.items.concat(second.items, third.items).map(item => item.id), Array.from({ length: 71 }, (_, i) => i + 1));
  assert.equal(calls.length, 3);
});

test('ascending reads detect a changing total instead of silently mixing pagination windows', async () => {
  const { ascendingPager } = require('../utils/report-order');
  const read = ascendingPager(async (url, params) => ({ total: params.page === 1 ? 71 : 72, items: [] }), { pageSize: 30 });
  await assert.rejects(read(1), /报告数量已变化/);
});

function pagedHarness(total = 95) {
  const calls = [];
  const rows = Array.from({ length: total }, (_, i) => ({ id: i + 1, relBarcode: 'external-' + i, barcode: 'internal-' + i, reportTime: new Date(Date.UTC(2026, 8, 27) - i * 3600000).toISOString() }));
  const lis = { request: async (url, params) => {
    calls.push({ url, ...params });
    if (url.endsWith('/stats')) return { total, withDanger: 2, withAbnormal: 3 };
    return { total, items: rows.slice((params.page - 1) * params.pageSize, params.page * params.pageSize) };
  }, readyAuth: async () => storedAuth() };
  const h = pageHarness('pages/report/result.js', lis, { currentReportQuery: { ...query } });
  h.calls = calls;
  h.page.onLoad();
  return h;
}

test('first page is 30 rows; page two replaces with rows 31-60; previous/next scroll to the list', async () => {
  const h = pagedHarness();
  await h.page._pagePromise;
  assert.equal(h.page.data.currentPage, 1);
  assert.equal(h.page.data.totalPages, 4);
  assert.equal(h.page.data.reports.length, 30);
  assert.equal(h.page.onReachBottom, undefined);
  assert.equal(h.page.onPageScroll, undefined);
  await h.page.changePage({ currentTarget: { dataset: { page: 2 } } });
  assert.equal(h.page.data.reports.length, 30);
  assert.equal(h.page.data.reports[0].id, 31);
  assert.equal(h.page.data.reports[29].id, 60);
  assert.equal(h.scrolls[0].selector, '#report-results');
  await h.page.changePage({ currentTarget: { dataset: { page: 1 } } });
  assert.equal(h.page.data.reports[0].id, 1);
  await h.page.changePage({ currentTarget: { dataset: { page: 4 } } });
  assert.equal(h.page.data.reports.length, 5);
  assert.equal(h.page.data.reports[0].id, 91);
  const count = h.calls.length;
  h.page.changePage({ currentTarget: { dataset: { page: 5 } } });
  assert.equal(h.calls.length, count);
});

test('date range popup defaults to current range; selection and cancel never query or change page', async () => {
  const h = pagedHarness();
  await h.page._pagePromise;
  await h.page.changePage({ currentTarget: { dataset: { page: 2 } } });
  const before = JSON.stringify(h.page.data.reports);
  const count = h.calls.length;
  h.page.openDateRange();
  assert.equal(h.page.calendarDay(h.page.data.calendarValue[0]), query.regeditTime);
  assert.equal(h.page.calendarDay(h.page.data.calendarValue[1]), query.regeditEndTime);
  h.page.onCalendarSelect({ detail: { value: [new Date(2026, 7, 1).getTime(), new Date(2026, 7, 2).getTime()] } });
  assert.equal(h.page.data.startDate, query.regeditTime);
  assert.equal(h.page.data.tempStartDate, '2026-08-01');
  h.page.closeDateRange({ detail: { trigger: 'overlay' } });
  assert.equal(h.page.data.calendarVisible, false);
  assert.equal(h.page.data.currentPage, 2);
  assert.equal(JSON.stringify(h.page.data.reports), before);
  assert.equal(h.calls.length, count);
  h.page.openDateRange();
  assert.equal(h.page.data.tempStartDate, query.regeditTime);
});

test('confirm range resets to one, refreshes total and preserves risk filters, search and sort', async () => {
  const h = pagedHarness();
  await h.page._pagePromise;
  h.page.setData({ criticalFilter: true, abnormalFilter: true, appliedKeyword: '患者', sortOrder: 'asc', sortIndex: 1 });
  await h.page.refreshResults();
  await h.page.changePage({ currentTarget: { dataset: { page: 3 } } });
  h.page.openDateRange();
  h.page.closeDateRange({ detail: { trigger: 'confirm-btn' } });
  h.page.confirmDateRange({ detail: { value: [new Date(2026, 7, 1).getTime(), new Date(2026, 7, 2).getTime()] } });
  await h.page._pagePromise;
  assert.equal(h.page.data.currentPage, 1);
  assert.equal(h.page.data.startDate, '2026-08-01');
  assert.equal(h.page.data.endDate, '2026-08-02');
  assert.equal(h.page.data.sortOrder, 'asc');
  assert.equal(h.page.data.calendarVisible, false);
  const request = h.calls.filter(call => call.url === '/reports').at(-1);
  assert.equal(request.beginTime, '2026-08-01T00:00:00+08:00');
  assert.equal(request.hasDanger, true);
  assert.equal(request.hasAbnormal, true);
  assert.equal(request.patientName, '患者');
  assert.equal(h.page.data.reports.length, 30);
});

test('risk, sort, page size and submitted name each reset to page one', async () => {
  const h = pagedHarness(155);
  await h.page._pagePromise;
  const changes = [
    () => h.page.toggleLisFilter({ currentTarget: { dataset: { field: 'criticalFilter' } } }),
    () => h.page.toggleLisFilter({ currentTarget: { dataset: { field: 'abnormalFilter' } } }),
    () => h.page.onSortChange({ detail: { value: 1 } }),
    () => h.page.onPageSizeChange({ detail: { value: 1 } }),
    () => { h.page.onKeywordInput({ detail: { value: 'test' } }); h.page.onKeywordConfirm(); }
  ];
  for (const change of changes) {
    await h.page.changePage({ currentTarget: { dataset: { page: 3 } } });
    change();
    assert.equal(h.page.data.currentPage, 1);
    await h.page._pagePromise;
    assert.equal(h.page.data.currentPage, 1);
    assert.ok(h.page.data.reports.length <= h.page.data.pageSize);
  }
  assert.equal(h.page.data.pageSize, 50);
  assert.equal(h.page.data.totalPages, 4);
  assert.equal(h.page.data.startDate, query.regeditTime);
});

test('pagination preserves committed conditions while typing a draft search and never sends barcode filters', async () => {
  const h = pagedHarness();
  await h.page._pagePromise;
  h.page.setData({ appliedKeyword: 'committed', criticalFilter: true, abnormalFilter: true });
  await h.page.refreshResults();
  h.page.onKeywordInput({ detail: { value: 'draft' } });
  await h.page.changePage({ currentTarget: { dataset: { page: 2 } } });
  const request = h.calls.at(-1);
  assert.equal(request.patientName, 'committed');
  assert.equal(request.hasDanger, true);
  assert.equal(request.hasAbnormal, true);
  assert.equal(request.relBarcode, undefined);
  assert.equal(h.page.data.barcode, undefined);
  assert.equal(h.page.onBarcodeInput, undefined);
  assert.equal(h.page.data.reports[0]._barcode, 'external-30');
});

test('ascending page navigation shows only its own global interval', async () => {
  const h = pagedHarness(71);
  await h.page._pagePromise;
  h.page.onSortChange({ detail: { value: 1 } });
  await h.page._pagePromise;
  assert.equal(h.page.data.reports[0].id, 71);
  assert.equal(h.page.data.reports[29].id, 42);
  await h.page.changePage({ currentTarget: { dataset: { page: 2 } } });
  assert.equal(h.page.data.reports.length, 30);
  assert.equal(h.page.data.reports[0].id, 41);
  assert.equal(h.page.data.reports[29].id, 12);
});

test('late page response cannot overwrite a new filter result; rapid page taps do not duplicate requests', async () => {
  const calls = [];
  const lis = { request: (url, params) => { const d = deferred(); calls.push({ params, ...d }); return d.promise; } };
  const h = pageHarness('pages/report/result.js', lis);
  h.page.setData({ query: { ...query }, startDate: query.regeditTime, endDate: query.regeditEndTime });
  const first = h.page.refreshResults();
  calls[0].resolve({ total: 150, items: [{ id: 1 }] }); await first;
  const old = h.page.changePage({ currentTarget: { dataset: { page: 2 } } });
  h.page.changePage({ currentTarget: { dataset: { page: 2 } } });
  assert.equal(calls.length, 2);
  h.page.toggleLisFilter({ currentTarget: { dataset: { field: 'criticalFilter' } } });
  calls[1].resolve({ total: 150, items: [{ id: 'old' }] }); await old;
  assert.equal(h.page.data.loading, true);
  calls[2].resolve({ total: 1, items: [{ id: 'new' }] }); await h.page._pagePromise;
  assert.equal(h.page.data.currentPage, 1);
  assert.equal(h.page.data.totalPages, 1);
  assert.equal(h.page.data.reports[0].id, 'new');
});

test('pathology uses slice for each page and retains full API result total', async () => {
  const rows = Array.from({ length: 71 }, (_, i) => ({ ReportID: i + 1, ReCheckDate: new Date(Date.UTC(2026, 0, 71 - i)).toISOString() }));
  const h = pageHarness('pages/report/result.js', {}, { currentReportQuery: { ...query, reportKind: 'pathology' }, currentReportList: rows });
  h.legacy.request = async () => ({ status: 1, list: rows });
  h.page.onLoad();
  assert.equal(h.page.data.reports.length, 30);
  h.page.changePage({ currentTarget: { dataset: { page: 2 } } });
  assert.equal(h.page.data.reports.length, 30);
  assert.equal(h.page.data.reports[0].ReportID, 31);
  assert.equal(h.page.data.total, 71);
  h.page.onSortChange({ detail: { value: 1 } }); await h.page._pagePromise;
  assert.equal(h.page.data.currentPage, 1);
  assert.equal(h.page.data.reports[0].ReportID, 71);
  assert.equal(h.page.data.reports.length, 30);
});

test('empty query has no invalid page and pagination includes bounded ellipses', async () => {
  const h = pagedHarness(0); await h.page._pagePromise;
  assert.equal(h.page.data.currentPage, 1);
  assert.equal(h.page.data.totalPages, 0);
  assert.equal(h.page.data.reports.length, 0);
  const numbers = h.page.pagination(50, 100);
  assert.deepEqual(Array.from(numbers, item => item.label), ['1', '…', '49', '50', '51', '…', '100']);
});
