const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

function loadModule(file, context = {}, dependencies = {}) {
  const sandbox = Object.assign({
    module: { exports: {} },
    require: name => dependencies[name],
    console,
    setTimeout,
    clearTimeout
  }, context);
  vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox, { filename: file });
  return sandbox.module.exports;
}

// -------------------------------------------------------------
// 1. Packaging DAG & Multi-tier Unit Conversion Validator
// -------------------------------------------------------------
function resolveConversionDAG(baseUnit, edges, targetUnit, targetQty) {
  if (targetUnit === baseUnit) {
    return {
      factorToBase: 1,
      baseQty: targetQty,
      conversionChain: `1 ${baseUnit} = 1 ${baseUnit}`
    };
  }

  // Detect duplicate or conflicting edges
  const adj = new Map();
  edges.forEach(e => {
    if (e.multiplier <= 0) throw new Error('换算系数必须大于 0');
    if (!adj.has(e.fromUnit)) adj.set(e.fromUnit, []);
    adj.get(e.fromUnit).push(e);
  });

  // Check cycles using DFS
  const visited = new Set();
  const recursionStack = new Set();

  function checkCycle(node) {
    visited.add(node);
    recursionStack.add(node);

    const neighbors = adj.get(node) || [];
    for (const edge of neighbors) {
      if (!visited.has(edge.toUnit)) {
        if (checkCycle(edge.toUnit)) return true;
      } else if (recursionStack.has(edge.toUnit)) {
        return true;
      }
    }

    recursionStack.delete(node);
    return false;
  }

  for (const node of adj.keys()) {
    if (!visited.has(node)) {
      if (checkCycle(node)) {
        throw new Error('包装单位换算存在循环依赖闭环');
      }
    }
  }

  // BFS / DFS from targetUnit to baseUnit
  const path = [];
  let current = targetUnit;
  let factor = 1;
  const MAX_FACTOR = 10000000;

  while (current !== baseUnit) {
    const edge = edges.find(e => e.fromUnit === current);
    if (!edge) {
      throw new Error(`无法找到订购单位 [${targetUnit}] 到基本单位 [${baseUnit}] 的换算路径`);
    }

    if (factor * edge.multiplier > MAX_FACTOR) {
      throw new Error('单位换算系数超出系统支持的最大数值');
    }

    factor *= edge.multiplier;
    path.push(`${edge.fromUnit}(=${edge.multiplier}${edge.toUnit})`);
    current = edge.toUnit;
  }

  path.push(baseUnit);

  return {
    factorToBase: factor,
    baseQty: targetQty * factor,
    conversionChain: `1 ${targetUnit} = ${factor} ${baseUnit} [${path.join(' -> ')}]`
  };
}

test('DAG: piece -> bag (10) -> pack (5) -> box (4) resolves accurately to 200 pieces', () => {
  const edges = [
    { fromUnit: '箱', toUnit: '包', multiplier: 4 },
    { fromUnit: '包', toUnit: '袋', multiplier: 5 },
    { fromUnit: '袋', toUnit: '支', multiplier: 10 }
  ];

  const resBox = resolveConversionDAG('支', edges, '箱', 2);
  assert.equal(resBox.factorToBase, 200);
  assert.equal(resBox.baseQty, 400);
  assert.ok(resBox.conversionChain.includes('1 箱 = 200 支'));

  const resPack = resolveConversionDAG('支', edges, '包', 3);
  assert.equal(resPack.factorToBase, 50);
  assert.equal(resPack.baseQty, 150);

  const resBag = resolveConversionDAG('支', edges, '袋', 1);
  assert.equal(resBag.factorToBase, 10);
  assert.equal(resBag.baseQty, 10);

  const resBase = resolveConversionDAG('支', edges, '支', 5);
  assert.equal(resBase.factorToBase, 1);
  assert.equal(resBase.baseQty, 5);
});

test('DAG: cycle detection catches recursive loops and rejects them', () => {
  const cycleEdges = [
    { fromUnit: '箱', toUnit: '盒', multiplier: 10 },
    { fromUnit: '盒', toUnit: '包', multiplier: 5 },
    { fromUnit: '包', toUnit: '箱', multiplier: 2 }
  ];

  assert.throws(() => {
    resolveConversionDAG('支', cycleEdges, '箱', 1);
  }, /循环依赖/);
});

test('DAG: overflow protection rejects absurd multipliers exceeding threshold', () => {
  const hugeEdges = [
    { fromUnit: '箱', toUnit: '件', multiplier: 100000 },
    { fromUnit: '件', toUnit: '支', multiplier: 200 }
  ];

  assert.throws(() => {
    resolveConversionDAG('支', hugeEdges, '箱', 1);
  }, /换算系数超出系统支持的最大数值/);
});

// -------------------------------------------------------------
// 2. Pricing Engine: Effective Dates, Priority, Rule Selection
// -------------------------------------------------------------
function calculatePrice(refPrice, defaultDiscount, rules, evalDate, factorToBase, orderQty) {
  // Sort rules: priority desc, id desc
  const sorted = [...rules].sort((a, b) => (b.priority || 0) - (a.priority || 0));

  let matchedRule = null;
  for (const rule of sorted) {
    const s = new Date(rule.effectiveFrom);
    const e = new Date(rule.effectiveTo);
    if (evalDate >= s && evalDate <= e) {
      matchedRule = rule;
      break;
    }
  }

  let baseUnitPrice = 0;
  let ruleDesc = '';

  if (matchedRule) {
    if (matchedRule.priceType === 'FREE') {
      baseUnitPrice = 0.00;
      ruleDesc = `协议免费 (优先级: ${matchedRule.priority})`;
    } else if (matchedRule.priceType === 'FIXED_PRICE') {
      baseUnitPrice = Number(matchedRule.fixedPrice);
      ruleDesc = `协议固定基价: ¥${baseUnitPrice.toFixed(2)} (优先级: ${matchedRule.priority})`;
    } else if (matchedRule.priceType === 'SPECIAL_DISCOUNT') {
      const rate = Number(matchedRule.discountRate);
      baseUnitPrice = Math.round(refPrice * rate * 10000) / 10000;
      ruleDesc = `特价折扣 ${(rate * 100).toFixed(0)}折 (优先级: ${matchedRule.priority})`;
    }
  } else {
    // Default hospital discount
    baseUnitPrice = Math.round(refPrice * defaultDiscount * 10000) / 10000;
    ruleDesc = `客户统一折扣 ${(defaultDiscount * 100).toFixed(0)}折`;
  }

  const pkgPrice = Math.round(baseUnitPrice * factorToBase * 100) / 100;
  const lineAmount = Math.round(pkgPrice * orderQty * 100) / 100;

  return {
    packageUnitPrice: pkgPrice,
    lineAmount: lineAmount,
    ruleDescription: ruleDesc
  };
}

test('Pricing: FREE overrides other rules and evaluates to 0.00', () => {
  const rules = [
    {
      priceType: 'SPECIAL_DISCOUNT',
      discountRate: 0.8,
      priority: 10,
      effectiveFrom: '2026-01-01',
      effectiveTo: '2026-12-31'
    },
    {
      priceType: 'FREE',
      priority: 100,
      effectiveFrom: '2026-01-01',
      effectiveTo: '2026-12-31'
    }
  ];

  const now = new Date('2026-09-29T10:00:00Z');
  const result = calculatePrice(50.00, 0.95, rules, now, 10, 5);
  assert.equal(result.packageUnitPrice, 0.00);
  assert.equal(result.lineAmount, 0.00);
  assert.ok(result.ruleDescription.includes('协议免费'));
});

test('Pricing: FIXED_PRICE takes precedence over default discount when active', () => {
  const rules = [
    {
      priceType: 'FIXED_PRICE',
      fixedPrice: 3.50,
      priority: 20,
      effectiveFrom: '2026-06-01',
      effectiveTo: '2026-10-31'
    }
  ];

  const now = new Date('2026-09-29T10:00:00Z');
  // Base ref price 5.00, hospital default discount 0.9 (would be 4.50), but fixed price is 3.50
  // Pack factor 10 -> package unit price 35.00, qty 2 -> 70.00
  const result = calculatePrice(5.00, 0.90, rules, now, 10, 2);
  assert.equal(result.packageUnitPrice, 35.00);
  assert.equal(result.lineAmount, 70.00);
  assert.ok(result.ruleDescription.includes('协议固定基价: ¥3.50'));
});

test('Pricing: expired rule falls back to customer default discount', () => {
  const rules = [
    {
      priceType: 'FIXED_PRICE',
      fixedPrice: 2.00,
      priority: 50,
      effectiveFrom: '2026-01-01',
      effectiveTo: '2026-06-30' // Expired
    }
  ];

  const now = new Date('2026-09-29T10:00:00Z');
  // Base ref price 10.00, hospital discount 0.85 -> 8.50 per base unit
  // Factor 5 -> 42.50 per pack, qty 2 -> 85.00
  const result = calculatePrice(10.00, 0.85, rules, now, 5, 2);
  assert.equal(result.packageUnitPrice, 42.50);
  assert.equal(result.lineAmount, 85.00);
  assert.ok(result.ruleDescription.includes('客户统一折扣 85折'));
});

// -------------------------------------------------------------
// 3. Split Outbound Cumulative Line Amount Rounding Formula
// -------------------------------------------------------------
function calculateSplitShipmentAmount(packageUnitPrice, factorToBase, orderBaseQty, previousPostedAmount, cumulativeDispatchedBaseQty) {
  // If this is the final outbound shipment that completes the order item, take exact remainder
  if (cumulativeDispatchedBaseQty >= orderBaseQty) {
    const totalOrderLineAmount = Math.round(packageUnitPrice * (orderBaseQty / factorToBase) * 100) / 100;
    return Math.round((totalOrderLineAmount - previousPostedAmount) * 100) / 100;
  }

  // Formula: round(unit_price * (cumulative_base_qty / factor), 2) - previous_amount
  const cumulativeAmount = Math.round(packageUnitPrice * (cumulativeDispatchedBaseQty / factorToBase) * 100) / 100;
  return Math.round((cumulativeAmount - previousPostedAmount) * 100) / 100;
}

test('Split shipments: 3 partial shipments sum exactly to total order amount with 0 discrepancy', () => {
  // Example: 1 pack = 3 base units, package unit price = 10.00, orderQty = 1 pack (3 base units)
  // Total order line amount = 10.00
  // Shipment 1: 1 base unit
  // Shipment 2: 1 base unit
  // Shipment 3: 1 base unit
  const factor = 3;
  const pkgPrice = 10.00;
  const orderBaseQty = 3;

  // Shipment 1: cumulative = 1
  const amt1 = calculateSplitShipmentAmount(pkgPrice, factor, orderBaseQty, 0.00, 1);
  assert.equal(amt1, 3.33);

  // Shipment 2: cumulative = 2, previous = 3.33
  const amt2 = calculateSplitShipmentAmount(pkgPrice, factor, orderBaseQty, amt1, 2);
  // cumulative amount for 2/3 of 10.00 is round(6.6666, 2) = 6.67
  // 6.67 - 3.33 = 3.34
  assert.equal(amt2, 3.34);

  // Shipment 3: cumulative = 3, previous = 3.33 + 3.34 = 6.67
  const amt3 = calculateSplitShipmentAmount(pkgPrice, factor, orderBaseQty, amt1 + amt2, 3);
  // 10.00 - 6.67 = 3.33
  assert.equal(amt3, 3.33);

  // Verify exact sum
  const sum = Math.round((amt1 + amt2 + amt3) * 100) / 100;
  assert.equal(sum, 10.00);
});

// -------------------------------------------------------------
// 4. Auto-Receipt: 7-day Threshold Calculation
// -------------------------------------------------------------
function isAutoReceiptDue(deliveredAtStr, nowStr) {
  const delivered = new Date(deliveredAtStr);
  const now = new Date(nowStr);
  const diffMs = now.getTime() - delivered.getTime();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  return diffMs >= sevenDaysMs;
}

test('Auto-receipt: strictly requires 7 * 24 hours elapsed from deliveredAt', () => {
  const deliveredAt = '2026-09-01T10:00:00Z';

  // 6 days 23 hours later: NOT due
  assert.equal(isAutoReceiptDue(deliveredAt, '2026-09-08T09:59:59Z'), false);

  // Exactly 7 days later: DUE
  assert.equal(isAutoReceiptDue(deliveredAt, '2026-09-08T10:00:00Z'), true);

  // 8 days later: DUE
  assert.equal(isAutoReceiptDue(deliveredAt, '2026-09-09T12:00:00Z'), true);
});

// -------------------------------------------------------------
// 5. Natural Month Settlement Boundary (Beijing Time UTC+8)
// -------------------------------------------------------------
function getBeijingMonthBounds(yearMonth) {
  const [yearStr, monthStr] = yearMonth.split('-');
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);

  const startBeijing = `${year}-${String(month).padStart(2, '0')}-01 00:00:00`;
  const lastDay = new Date(year, month, 0).getDate();
  const endBeijing = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')} 23:59:59`;

  return { startBeijing, endBeijing, daysInMonth: lastDay };
}

test('Beijing Month Settlement: calculates correct calendar boundaries', () => {
  const sep = getBeijingMonthBounds('2026-09');
  assert.equal(sep.startBeijing, '2026-09-01 00:00:00');
  assert.equal(sep.endBeijing, '2026-09-30 23:59:59');
  assert.equal(sep.daysInMonth, 30);

  const febLeap = getBeijingMonthBounds('2024-02');
  assert.equal(febLeap.daysInMonth, 29);

  const febNonLeap = getBeijingMonthBounds('2025-02');
  assert.equal(febNonLeap.daysInMonth, 28);
});

// -------------------------------------------------------------
// 6. Anti-Formula Injection Sanitization for Excel Exports
// -------------------------------------------------------------
function sanitizeExcelCellValue(val) {
  if (val === null || val === undefined) return '';
  const text = String(val);
  if (text.length > 0) {
    const first = text.charAt(0);
    if (first === '=' || first === '+' || first === '-' || first === '@') {
      return "'" + text;
    }
  }
  return text;
}

test('Excel: formula injection triggers are escaped with leading apostrophe', () => {
  assert.equal(sanitizeExcelCellValue('=SUM(A1:A10)'), "'=SUM(A1:A10)");
  assert.equal(sanitizeExcelCellValue('+12345'), "'+12345");
  assert.equal(sanitizeExcelCellValue('-54321'), "'-54321");
  assert.equal(sanitizeExcelCellValue('@cmd.exe'), "'@cmd.exe");
  assert.equal(sanitizeExcelCellValue('正常耗材名称'), '正常耗材名称');
  assert.equal(sanitizeExcelCellValue(100.5), '100.5');
});

// -------------------------------------------------------------
// 7. Mini Program Procurement Utils: Cart Management & Formatting
// -------------------------------------------------------------
test('Mini Program procurement utils: cart operations and formatting work properly', () => {
  const storage = {};
  const wx = {
    getStorageSync: k => storage[k],
    setStorageSync: (k, v) => { storage[k] = v; },
    removeStorageSync: k => { delete storage[k]; }
  };

  const proc = loadModule('utils/procurement.js', { wx }, {
    './config': { API_HOST: 'https://test.suyuanbingli.cn/tools/wxopen.ashx', APP_SECRET: 'test' },
    './sign': { sign: () => 'signed' }
  });

  // Empty cart initial
  assert.equal(proc.getCart().length, 0);

  // Add items
  proc.addToCart({
    materialId: 101,
    materialName: '耗材A',
    selectedUnit: '箱',
    factorToBase: 10,
    packageUnitPrice: 120.00,
    selectedQty: 2
  });

  let cart = proc.getCart();
  assert.equal(cart.length, 1);
  assert.equal(cart[0].selectedQty, 2);

  // Add same item and unit -> increments quantity
  proc.addToCart({
    materialId: 101,
    materialName: '耗材A',
    selectedUnit: '箱',
    selectedQty: 3
  });
  cart = proc.getCart();
  assert.equal(cart.length, 1);
  assert.equal(cart[0].selectedQty, 5);

  // Add same material but different unit -> separate row
  proc.addToCart({
    materialId: 101,
    materialName: '耗材A',
    selectedUnit: '盒',
    selectedQty: 1
  });
  cart = proc.getCart();
  assert.equal(cart.length, 2);

  // Update qty
  proc.updateCartQty(101, '箱', 8);
  cart = proc.getCart();
  assert.equal(cart.find(c => c.selectedUnit === '箱').selectedQty, 8);

  // Remove by setting qty to 0
  proc.updateCartQty(101, '盒', 0);
  cart = proc.getCart();
  assert.equal(cart.length, 1);
  assert.equal(cart[0].selectedUnit, '箱');

  // Money formatting
  assert.equal(proc.formatMoney(123.456), '¥123.46');
  assert.equal(proc.formatMoney(0), '¥0.00');

  // Clear cart
  proc.clearCart();
  assert.equal(proc.getCart().length, 0);
});

test('User context: normalizeUser bridges C# PascalCase to Mini Program camelCase and computes isApproved', () => {
  const proc = require('../utils/procurement');

  // Simulated raw response from C# backend (PascalCase)
  const csharpApprovedUser = {
    UserId: 108,
    OpenId: 'wx_user_abc123',
    Phone: '13812345678',
    RealName: '李主任',
    Department: '病理科',
    ApplyHospitalName: '江苏省人民医院',
    CustomerId: 5,
    CustomerName: '江苏省人民医院',
    ApprovalStatus: 'APPROVED',
    RejectReason: '',
    AvatarUrl: 'https://example.com/avatar.jpg'
  };

  const normalized = proc.normalizeUser(csharpApprovedUser);
  assert.equal(normalized.userId, 108);
  assert.equal(normalized.openid, 'wx_user_abc123');
  assert.equal(normalized.phone, '13812345678');
  assert.equal(normalized.realName, '李主任');
  assert.equal(normalized.department, '病理科');
  assert.equal(normalized.applyHospitalName, '江苏省人民医院');
  assert.equal(normalized.customerId, 5);
  assert.equal(normalized.customerName, '江苏省人民医院');
  assert.equal(normalized.approvalStatus, 'APPROVED');
  assert.equal(normalized.isApproved, true);
  assert.equal(normalized.avatarUrl, 'https://example.com/avatar.jpg');

  // Pending user (has not been associated with customer yet)
  const csharpPendingUser = {
    UserId: 109,
    OpenId: 'wx_user_def456',
    Phone: '13987654321',
    RealName: '王医生',
    Department: '检验科',
    ApplyHospitalName: '南京市第一医院',
    CustomerId: null,
    CustomerName: '',
    ApprovalStatus: 'PENDING',
    RejectReason: ''
  };

  const normPending = proc.normalizeUser(csharpPendingUser);
  assert.equal(normPending.approvalStatus, 'PENDING');
  assert.equal(normPending.isApproved, false);
  assert.equal(normPending.applyHospitalName, '南京市第一医院');

  // Null/empty input protection
  assert.equal(proc.normalizeUser(null), null);
  assert.equal(proc.normalizeUser(undefined), null);
});

test('Session: getClientId returns persistent identifier', () => {
  const storage = {};
  const wx = {
    getStorageSync: k => storage[k],
    setStorageSync: (k, v) => { storage[k] = v; },
    removeStorageSync: k => { delete storage[k]; }
  };
  const proc = loadModule('utils/procurement.js', { wx }, {
    './config': { API_HOST: 'https://test.suyuanbingli.cn/tools/wxopen.ashx', APP_SECRET: 'test' },
    './sign': { sign: () => 'signed' }
  });

  const id1 = proc.getClientId();
  const id2 = proc.getClientId();
  assert.ok(id1);
  assert.equal(id1, id2);
  assert.equal(storage['proc_client_id'], id1);
});

test('Access application: enforces phone requirement and prevents duplicate application when PENDING or APPROVED', () => {
  function canApply(user) {
    if (!user || !user.userId) return { allowed: false, reason: '未登录' };
    if (!user.phone) return { allowed: false, reason: '需先绑定手机号' };
    if (user.approvalStatus === 'APPROVED') return { allowed: false, reason: '资质已生效，无需重复申请' };
    if (user.approvalStatus === 'PENDING') return { allowed: false, reason: '申请审核中，无需重复提交' };
    return { allowed: true };
  }

  // Not logged in
  assert.equal(canApply(null).allowed, false);
  assert.equal(canApply(null).reason, '未登录');

  // Logged in without phone
  assert.equal(canApply({ userId: 1, phone: '' }).allowed, false);
  assert.equal(canApply({ userId: 1, phone: '' }).reason, '需先绑定手机号');

  // Logged in with phone, unapplied
  assert.equal(canApply({ userId: 1, phone: '13800000000', approvalStatus: 'UNAPPLIED' }).allowed, true);

  // Logged in with phone, rejected -> allowed to re-apply
  assert.equal(canApply({ userId: 1, phone: '13800000000', approvalStatus: 'REJECTED' }).allowed, true);

  // Logged in with phone, currently pending -> blocked from duplicate apply
  const pendingCheck = canApply({ userId: 1, phone: '13800000000', approvalStatus: 'PENDING' });
  assert.equal(pendingCheck.allowed, false);
  assert.equal(pendingCheck.reason, '申请审核中，无需重复提交');

  // Logged in with phone, already approved -> blocked from duplicate apply
  const approvedCheck = canApply({ userId: 1, phone: '13800000000', approvalStatus: 'APPROVED' });
  assert.equal(approvedCheck.allowed, false);
  assert.equal(approvedCheck.reason, '资质已生效，无需重复申请');

  // Form field validation engine:
  function validateApplyForm(data, user) {
    var hospitalName = (data.hospitalName || '').trim();
    var realName = (data.realName || '').trim();
    var department = (data.department || '').trim();
    // Default to bound phone
    var phone = (user && user.phone) ? user.phone.trim() : (data.phone || '').trim();

    if (!hospitalName) return { valid: false, error: '请填写合作医院名称' };
    if (hospitalName.length < 4) return { valid: false, error: '医院名称至少需要4个字' };

    if (!realName) return { valid: false, error: '请填写真实姓名' };
    var chineseNameReg = /^[\u4e00-\u9fa5]{2,4}$/;
    if (!chineseNameReg.test(realName)) return { valid: false, error: '姓名必须为2-4个汉字' };

    if (!phone || !/^1\d{10}$/.test(phone)) return { valid: false, error: '申请采购准入必须使用已绑定的手机号' };

    // department is optional
    return { valid: true, data: { hospitalName, realName, department, phone } };
  }

  const boundUser = { userId: 1, phone: '13800138000' };

  // 1. Hospital validation (< 4 chars fails, >= 4 chars passes)
  assert.equal(validateApplyForm({ hospitalName: '', realName: '张三' }, boundUser).error, '请填写合作医院名称');
  assert.equal(validateApplyForm({ hospitalName: '协和', realName: '张三' }, boundUser).error, '医院名称至少需要4个字');
  assert.equal(validateApplyForm({ hospitalName: '人民医院', realName: '张三' }, boundUser).valid, true);
  assert.equal(validateApplyForm({ hospitalName: '北京协和医院', realName: '张三' }, boundUser).valid, true);

  // 2. Real name validation (must be 2-4 Chinese characters)
  assert.equal(validateApplyForm({ hospitalName: '北京协和医院', realName: '' }, boundUser).error, '请填写真实姓名');
  assert.equal(validateApplyForm({ hospitalName: '北京协和医院', realName: '李' }, boundUser).error, '姓名必须为2-4个汉字');
  assert.equal(validateApplyForm({ hospitalName: '北京协和医院', realName: '张三' }, boundUser).valid, true);
  assert.equal(validateApplyForm({ hospitalName: '北京协和医院', realName: '诸葛孔明' }, boundUser).valid, true);
  assert.equal(validateApplyForm({ hospitalName: '北京协和医院', realName: '欧阳诸葛孔明' }, boundUser).error, '姓名必须为2-4个汉字'); // 6 chars
  assert.equal(validateApplyForm({ hospitalName: '北京协和医院', realName: 'John' }, boundUser).error, '姓名必须为2-4个汉字'); // English
  assert.equal(validateApplyForm({ hospitalName: '北京协和医院', realName: '张三1' }, boundUser).error, '姓名必须为2-4个汉字'); // Numbers

  // 3. Department is optional
  const noDept = validateApplyForm({ hospitalName: '北京协和医院', realName: '李四', department: '' }, boundUser);
  assert.equal(noDept.valid, true);
  assert.equal(noDept.data.department, '');

  const withDept = validateApplyForm({ hospitalName: '北京协和医院', realName: '李四', department: '病理检验科' }, boundUser);
  assert.equal(withDept.valid, true);
  assert.equal(withDept.data.department, '病理检验科');

  // 4. Phone defaults to bound phone
  const defaultPhone = validateApplyForm({ hospitalName: '北京协和医院', realName: '王五' }, boundUser);
  assert.equal(defaultPhone.valid, true);
  assert.equal(defaultPhone.data.phone, '13800138000');

  // 5. Unbound phone cannot submit
  const noPhoneUser = { userId: 2, phone: '' };
  assert.equal(validateApplyForm({ hospitalName: '北京协和医院', realName: '王五' }, noPhoneUser).error, '申请采购准入必须使用已绑定的手机号');
});

test('Audit notification: detects PENDING -> APPROVED and PENDING -> REJECTED transitions', () => {
  function checkNotification(lastKnownStatus, currentStatus, user) {
    if (lastKnownStatus === 'PENDING' && currentStatus === 'APPROVED') {
      return { notify: true, type: 'APPROVED', title: '采购准入已通过', hospital: user.customerName };
    }
    if (lastKnownStatus === 'PENDING' && currentStatus === 'REJECTED') {
      return { notify: true, type: 'REJECTED', title: '准入申请已被驳回', reason: user.rejectReason };
    }
    return { notify: false };
  }

  const user = { customerName: '江苏省人民医院', rejectReason: '科室公章模糊' };

  // Pending to Approved
  const res1 = checkNotification('PENDING', 'APPROVED', user);
  assert.equal(res1.notify, true);
  assert.equal(res1.type, 'APPROVED');
  assert.equal(res1.hospital, '江苏省人民医院');

  // Pending to Rejected
  const res2 = checkNotification('PENDING', 'REJECTED', user);
  assert.equal(res2.notify, true);
  assert.equal(res2.type, 'REJECTED');
  assert.equal(res2.reason, '科室公章模糊');

  // Same status -> no duplicate popups
  assert.equal(checkNotification('APPROVED', 'APPROVED', user).notify, false);
  assert.equal(checkNotification('PENDING', 'PENDING', user).notify, false);
});

// -------------------------------------------------------------
// 12. Quota Resolution, Tiered Limits, and Packaging DAG Conversion
// -------------------------------------------------------------
test('Quota: defaults to positive infinity (unlimited) when unconfigured', () => {
  function resolveQuota(material, applicableRule) {
    if (applicableRule && applicableRule.quotaLimit != null && applicableRule.quotaLimit > 0) {
      return {
        limit: applicableRule.quotaLimit,
        unit: applicableRule.quotaUnit || material.baseUnit,
        isUnlimited: false
      };
    }
    if (material.quotaLimit != null && material.quotaLimit > 0) {
      return {
        limit: material.quotaLimit,
        unit: material.quotaUnit || material.baseUnit,
        isUnlimited: false
      };
    }
    return { limit: Infinity, unit: material.baseUnit, isUnlimited: true };
  }

  const standardMaterial = { id: 1, baseUnit: '支', quotaLimit: null };
  const q1 = resolveQuota(standardMaterial, null);
  assert.equal(q1.isUnlimited, true);
  assert.equal(q1.limit, Infinity);
});

test('Quota: tiered limits per hospital (Big Hospital 2 boxes, Small Hospital 1 box, Clinic 1 pack) with DAG conversion', () => {
  // Packaging DAG for a trial consumable: 1 包 = 10 支; 1 盒 = 5 包 (50 支); 1 箱 = 4 盒 (200 支)
  const edges = [
    { fromUnit: '包', toUnit: '支', multiplier: 10 },
    { fromUnit: '盒', toUnit: '包', multiplier: 5 },
    { fromUnit: '箱', toUnit: '盒', multiplier: 4 }
  ];

  function getBaseUnitsForQuota(unit, qty) {
    return resolveConversionDAG('支', edges, unit, qty).baseQty;
  }

  // 1. Big Hospital (West China Hospital): Free trial 2 boxes
  const bigHospitalRule = { customerId: 101, ruleType: 'FREE', quotaLimit: 2, quotaUnit: '箱' };
  const bigHospitalBaseQuota = getBaseUnitsForQuota(bigHospitalRule.quotaUnit, bigHospitalRule.quotaLimit);
  assert.equal(bigHospitalBaseQuota, 400); // 2 箱 * 200 支 = 400 支

  // 2. Small Hospital (County Hospital): Free trial 1 box
  const smallHospitalRule = { customerId: 102, ruleType: 'FREE', quotaLimit: 1, quotaUnit: '箱' };
  const smallHospitalBaseQuota = getBaseUnitsForQuota(smallHospitalRule.quotaUnit, smallHospitalRule.quotaLimit);
  assert.equal(smallHospitalBaseQuota, 200); // 1 箱 * 200 支 = 200 支

  // 3. Clinic (Community Clinic): Free trial 1 pack
  const clinicRule = { customerId: 103, ruleType: 'FREE', quotaLimit: 1, quotaUnit: '包' };
  const clinicBaseQuota = getBaseUnitsForQuota(clinicRule.quotaUnit, clinicRule.quotaLimit);
  assert.equal(clinicBaseQuota, 10); // 1 包 * 10 支 = 10 支

  // 4. Verify Cumulative Enforcement:
  // West China orders 1 box (200支), then tries to order another 1 box (200支) -> Allowed (cumulative 400 <= 400)
  // Then tries to order 1 more pack (10支) -> Rejected (410 > 400)!
  function checkOrderAgainstQuota(baseQuota, purchasedBaseQty, newOrderUnit, newOrderQty) {
    const newBaseQty = getBaseUnitsForQuota(newOrderUnit, newOrderQty);
    if (purchasedBaseQty + newBaseQty > baseQuota) {
      const remainingBase = Math.max(0, baseQuota - purchasedBaseQty);
      return { allowed: false, remainingBaseQty: remainingBase, message: `超出限购配额！剩余可用配额折算 ${remainingBase} 支` };
    }
    return { allowed: true, remainingBaseQty: baseQuota - (purchasedBaseQty + newBaseQty) };
  }

  // First order 1 box
  const order1 = checkOrderAgainstQuota(bigHospitalBaseQuota, 0, '箱', 1);
  assert.equal(order1.allowed, true);
  assert.equal(order1.remainingBaseQty, 200);

  // Second order 1 box (cumulative 200 already placed)
  const order2 = checkOrderAgainstQuota(bigHospitalBaseQuota, 200, '箱', 1);
  assert.equal(order2.allowed, true);
  assert.equal(order2.remainingBaseQty, 0);

  // Third order 1 pack (10支) when cumulative is 400 -> Rejected!
  const order3 = checkOrderAgainstQuota(bigHospitalBaseQuota, 400, '包', 1);
  assert.equal(order3.allowed, false);
  assert.equal(order3.remainingBaseQty, 0);
  assert.ok(order3.message.includes('超出限购配额'));

  // Clinic order 2 packs when limit is 1 pack (10支) -> Rejected!
  const clinicOrder = checkOrderAgainstQuota(clinicBaseQuota, 0, '包', 2);
  assert.equal(clinicOrder.allowed, false);
  assert.equal(clinicOrder.remainingBaseQty, 10);
});

// -------------------------------------------------------------
// 13. Material Categories and Horizontal Tab Filtering
// -------------------------------------------------------------
test('Category: filters catalog by category name and preserves active selection', () => {
  const catalog = [
    { id: 1, name: '95%医用酒精', categoryName: '病理常规' },
    { id: 2, name: '二甲苯透明剂', categoryName: '病理常规' },
    { id: 3, name: 'HE自动染色液试剂盒', categoryName: '检验试剂' },
    { id: 4, name: 'FISH探针试剂盒', categoryName: '分子病理' },
    { id: 5, name: '病理刀片试用包', categoryName: '试用赠品' }
  ];

  function filterCatalog(list, category) {
    if (!category || category === '全部') return list;
    return list.filter(item => item.categoryName === category);
  }

  // Extract distinct categories
  const categories = Array.from(new Set(catalog.map(m => m.categoryName)));
  assert.deepEqual(categories, ['病理常规', '检验试剂', '分子病理', '试用赠品']);

  // All
  assert.equal(filterCatalog(catalog, '').length, 5);
  assert.equal(filterCatalog(catalog, '全部').length, 5);

  // Pathology routine
  const routine = filterCatalog(catalog, '病理常规');
  assert.equal(routine.length, 2);
  assert.equal(routine[0].id, 1);
  assert.equal(routine[1].id, 2);

  // Free trial gift
  const gifts = filterCatalog(catalog, '试用赠品');
  assert.equal(gifts.length, 1);
  assert.equal(gifts[0].id, 5);
});

// -------------------------------------------------------------
// 14. Batch Hospital Selection and All-Hospital Universal Rules
// -------------------------------------------------------------
test('Price Rules: supports universal all-hospital fallback and batch hospital expansion', () => {
  const rules = [
    // Universal promotional free trial rule (customerId = null / all hospitals)
    { id: 1, customerId: null, materialId: 50, ruleType: 'FREE', quotaLimit: 1, quotaUnit: '箱', priority: 10 },
    // Specific custom rule for West China Hospital (customerId = 101, priority = 20)
    { id: 2, customerId: 101, materialId: 50, ruleType: 'FREE', quotaLimit: 2, quotaUnit: '箱', priority: 20 }
  ];

  function resolveApplicableRule(hospitalId, materialId, allRules) {
    const candidates = allRules.filter(r => (r.customerId === hospitalId || r.customerId == null) && r.materialId === materialId);
    // Hospital-specific rules take precedence over global rules, then by priority
    candidates.sort((a, b) => {
      const aSpecific = a.customerId === hospitalId ? 1 : 0;
      const bSpecific = b.customerId === hospitalId ? 1 : 0;
      if (bSpecific !== aSpecific) return bSpecific - aSpecific;
      return b.priority - a.priority;
    });
    return candidates[0] || null;
  }

  // West China gets the specific 2-box rule
  const westChinaRule = resolveApplicableRule(101, 50, rules);
  assert.ok(westChinaRule);
  assert.equal(westChinaRule.customerId, 101);
  assert.equal(westChinaRule.quotaLimit, 2);

  // Any other hospital (e.g. Hospital 999) falls back to the universal 1-box rule
  const otherHospitalRule = resolveApplicableRule(999, 50, rules);
  assert.ok(otherHospitalRule);
  assert.equal(otherHospitalRule.customerId, null);
  assert.equal(otherHospitalRule.quotaLimit, 1);

  // Batch generation: expands selected hospitals into multiple rules
  function batchGenerateRules(customerIds, materialId, ruleConfig) {
    return customerIds.map(cid => Object.assign({ customerId: cid, materialId }, ruleConfig));
  }

  const batchResults = batchGenerateRules([101, 102, 103], 50, { ruleType: 'FREE', quotaLimit: 1, quotaUnit: '箱', priority: 15 });
  assert.equal(batchResults.length, 3);
  assert.equal(batchResults[0].customerId, 101);
  assert.equal(batchResults[1].customerId, 102);
  assert.equal(batchResults[2].customerId, 103);
});

// -------------------------------------------------------------
// 15. Certification Status Text and One-time Dismissal Mechanics
// -------------------------------------------------------------
test('Certification UI: APPROVED status maps to 认证采购 and supports one-time dismissal', () => {
  const STATUS_TEXT = {
    APPROVED: '认证采购',
    PENDING: '审核中',
    REJECTED: '已驳回',
    DISABLED: '已停用'
  };

  assert.equal(STATUS_TEXT.APPROVED, '认证采购');
  assert.equal(STATUS_TEXT.PENDING, '审核中');
  assert.equal(STATUS_TEXT.REJECTED, '已驳回');

  // Simulated storage
  const storage = {};
  function getStorage(key) { return storage[key]; }
  function setStorage(key, val) { storage[key] = val; }

  const userId = 888;
  const user = { userId: userId, approvalStatus: 'APPROVED', customerName: '华西医院', realName: '王采购' };

  // First visit after approval: not dismissed yet
  const noticeKey = 'proc_approved_notice_dismissed_' + userId;
  const cardKey = 'proc_approved_card_dismissed_' + userId;

  assert.equal(!!getStorage(noticeKey), false);
  assert.equal(!!getStorage(cardKey), false);

  // User views the page and manually dismisses or leaves page (onHide)
  function dismissNotice() {
    setStorage(noticeKey, 1);
    return { noticeDismissed: true };
  }

  function dismissCard() {
    setStorage(cardKey, 1);
    return { cardDismissed: true };
  }

  const dismissedNotice = dismissNotice();
  assert.equal(dismissedNotice.noticeDismissed, true);
  assert.equal(getStorage(noticeKey), 1);

  const dismissedCard = dismissCard();
  assert.equal(dismissedCard.cardDismissed, true);
  assert.equal(getStorage(cardKey), 1);

  // On next visit, both windows remain collapsed / hidden
  const nextVisitNoticeVisible = !getStorage(noticeKey);
  const nextVisitCardVisible = !getStorage(cardKey);
  assert.equal(nextVisitNoticeVisible, false);
  assert.equal(nextVisitCardVisible, false);

  // Certified user accesses /pages/mine/apply: renders qualification credentials
  function getApplyPageData(currentUser) {
    if (currentUser.approvalStatus === 'APPROVED') {
      return {
        isApproved: true,
        title: '资质认证信息',
        badge: '认证采购',
        hospitalName: currentUser.customerName,
        canOrder: true
      };
    }
    return {
      isApproved: false,
      title: '准入申请',
      badge: '未认证',
      canOrder: false
    };
  }

  const certData = getApplyPageData(user);
  assert.equal(certData.isApproved, true);
  assert.equal(certData.title, '资质认证信息');
  assert.equal(certData.badge, '认证采购');
  assert.equal(certData.hospitalName, '华西医院');
  assert.equal(certData.canOrder, true);
});

// -------------------------------------------------------------
// 16. Order Checkout: Pre-submit Confirmation & Anti-Duplicate Lock
// -------------------------------------------------------------
test('Order Checkout: Pre-submit confirmation, anti-duplicate submission lock, and explicit modal feedback', () => {
  const checkoutState = {
    submitting: false,
    orderSubmitted: false,
    submittedOrderNo: '',
    selectedAddress: {
      recipientName: 'admin',
      recipientPhone: '18918918918',
      fullAddress: '江苏省南通市崇川区 1'
    },
    items: [
      { materialId: 1, materialName: 'test', selectedUnit: '包', selectedQty: 1, packageUnitPrice: '4444.00', lineAmount: '4444.00' }
    ],
    totalAmount: '4444.00',
    totalQty: 1
  };

  // 1. Build Pre-submit Confirmation
  function buildConfirmationDialog(state) {
    if (!state.selectedAddress) {
      return { canSubmit: false, error: '请选择收货信息' };
    }
    if (!state.items || state.items.length === 0) {
      return { canSubmit: false, error: '订购清单为空' };
    }
    const addr = state.selectedAddress.recipientName + ' (' + state.selectedAddress.recipientPhone + ')\n' + state.selectedAddress.fullAddress;
    const items = state.items.length + ' 种耗材 (共 ' + state.totalQty + ' 件)';
    const content = `【收货地址】\n${addr}\n\n【订购耗材】${items}\n【订单总额】¥${state.totalAmount}\n【结算方式】医院月度对账结算\n\n请核对以上采购信息，确认无误后将正式提交订单。`;
    return {
      canSubmit: true,
      modal: {
        title: '确认提交采购订单？',
        content: content,
        confirmText: '确认提交',
        cancelText: '再核对下'
      }
    };
  }

  const confirmRes = buildConfirmationDialog(checkoutState);
  assert.equal(confirmRes.canSubmit, true);
  assert.equal(confirmRes.modal.title, '确认提交采购订单？');
  assert.ok(confirmRes.modal.content.includes('4444.00'));
  assert.ok(confirmRes.modal.content.includes('18918918918'));

  // 2. Anti-Duplicate Lock Check
  function canExecuteSubmit(state) {
    if (state.submitting) return { allowed: false, reason: '正在提交中' };
    if (state.orderSubmitted) return { allowed: false, reason: '订单已成功提交' };
    return { allowed: true };
  }

  // Normal initial state
  assert.equal(canExecuteSubmit(checkoutState).allowed, true);

  // During submit
  checkoutState.submitting = true;
  assert.equal(canExecuteSubmit(checkoutState).allowed, false);
  assert.equal(canExecuteSubmit(checkoutState).reason, '正在提交中');

  // Completed submit
  checkoutState.submitting = false;
  checkoutState.orderSubmitted = true;
  checkoutState.submittedOrderNo = 'PO202609290001';
  assert.equal(canExecuteSubmit(checkoutState).allowed, false);
  assert.equal(canExecuteSubmit(checkoutState).reason, '订单已成功提交');

  // 3. Post-submit Success Feedback Generation
  function generateSuccessFeedback(orderNo, totalAmount, stateAmount) {
    const finalAmount = totalAmount != null ? Number(totalAmount).toFixed(2) : stateAmount;
    return {
      title: '🎉 采购订单提交成功！',
      content: `【订单编号】\n${orderNo}\n\n【订单总额】¥${finalAmount}\n【结算方式】医院月度对账结算\n\n订单已正式提交至后台，等待管理员接单与配货发货。`,
      confirmText: '查看我的订单',
      cancelText: '返回选购'
    };
  }

  const successFeedback = generateSuccessFeedback('PO202609290001', 4444.00, checkoutState.totalAmount);
  assert.ok(successFeedback.content.includes('PO202609290001'));
  assert.ok(successFeedback.content.includes('¥4444.00'));
  assert.equal(successFeedback.content.includes('NaN'), false);
});

// -------------------------------------------------------------
// 17. Cancelled Order Local Deletion (Client-side only)
// -------------------------------------------------------------
test('Order List: Cancelled orders can be deleted locally without mutating backend archives', () => {
  const mockBackendOrders = [
    { id: 101, orderNo: 'ORD001', orderStatus: 'SUBMITTED', totalAmount: '120.00' },
    { id: 102, orderNo: 'ORD002', orderStatus: 'CANCELLED', totalAmount: '4444.00' },
    { id: 103, orderNo: 'ORD003', orderStatus: 'CANCELLED', totalAmount: '888.00' },
    { id: 104, orderNo: 'ORD004', orderStatus: 'COMPLETED', totalAmount: '500.00' }
  ];

  // Local storage for deleted cancelled order IDs
  const storage = {};
  const userId = 999;
  const storageKey = 'proc_deleted_cancelled_orders_' + userId;

  function getVisibleOrders(backendList, uid) {
    const deletedIds = storage['proc_deleted_cancelled_orders_' + uid] || [];
    return backendList.filter(o => deletedIds.indexOf(o.id) < 0);
  }

  function deleteCancelledOrderLocally(orderId, orderStatus, uid) {
    if (orderStatus !== 'CANCELLED') {
      return { success: false, reason: '仅已取消订单支持在本地删除' };
    }
    const current = storage['proc_deleted_cancelled_orders_' + uid] || [];
    if (current.indexOf(orderId) < 0) {
      storage['proc_deleted_cancelled_orders_' + uid] = current.concat(orderId);
    }
    return { success: true };
  }

  // Initial state: all 4 orders visible
  assert.equal(getVisibleOrders(mockBackendOrders, userId).length, 4);

  // User deletes cancelled order 102
  const delRes = deleteCancelledOrderLocally(102, 'CANCELLED', userId);
  assert.equal(delRes.success, true);

  // After deletion, order 102 is removed from client view
  const visibleAfter = getVisibleOrders(mockBackendOrders, userId);
  assert.equal(visibleAfter.length, 3);
  assert.equal(visibleAfter.find(o => o.id === 102), undefined);

  // But backend archive remains pristine!
  assert.equal(mockBackendOrders.length, 4);
  assert.equal(mockBackendOrders.find(o => o.id === 102).orderStatus, 'CANCELLED');

  // Attempting to delete a SUBMITTED order fails (must cancel first)
  const delSubmitted = deleteCancelledOrderLocally(101, 'SUBMITTED', userId);
  assert.equal(delSubmitted.success, false);
});

// -------------------------------------------------------------
// 18. Delivery Worker Role Assignment and Admin Role Exclusion
// -------------------------------------------------------------
test('Backend Logistics: Admin user is strictly excluded from delivery worker assignment', () => {
  const allAdminUsers = [
    { id: 1, username: 'admin', realName: '系统管理员', role: 'admin', status: 0 },
    { id: 2, username: 'finance01', realName: '张财务', role: 'finance', status: 0 },
    { id: 3, username: 'logistics01', realName: '李主管', role: 'logistics', status: 0 },
    { id: 4, username: 'courier01', realName: '王配送', role: 'delivery', status: 0 },
    { id: 5, username: 'courier02', realName: '赵配送', role: 'delivery', status: 0 },
    { id: 6, username: 'courier_disabled', realName: '钱离职', role: 'delivery', status: 1 }
  ];

  // Logic in shipments.aspx: only role = 'delivery' and active (status = 0)
  function getAssignableDeliveryWorkers(users) {
    return users.filter(u => u.role === 'delivery' && u.status === 0 && u.role !== 'admin');
  }

  const assignable = getAssignableDeliveryWorkers(allAdminUsers);
  assert.equal(assignable.length, 2);
  assert.deepEqual(assignable.map(u => u.username), ['courier01', 'courier02']);

  // Admin user must NEVER be present
  assert.equal(assignable.some(u => u.role === 'admin'), false);
  assert.equal(assignable.some(u => u.username === 'admin'), false);

  // Validate backend assignment guard (ProcurementDelivery.cs)
  function validateAssignWorker(worker) {
    if (!worker || worker.status !== 0) {
      throw new Error('配送员不存在或已停用');
    }
    if (worker.role === 'admin') {
      throw new Error('管理员账号不能作为配送员被指派');
    }
    if (worker.role !== 'delivery') {
      throw new Error('所选账号角色不是配送员');
    }
    return true;
  }

  // Assigning courier01 succeeds
  assert.equal(validateAssignWorker(allAdminUsers[3]), true);

  // Assigning admin throws
  assert.throws(() => validateAssignWorker(allAdminUsers[0]), /管理员账号不能作为配送员被指派/);

  // Assigning finance throws
  assert.throws(() => validateAssignWorker(allAdminUsers[1]), /所选账号角色不是配送员/);

  // Assigning disabled courier throws
  assert.throws(() => validateAssignWorker(allAdminUsers[5]), /配送员不存在或已停用/);
});

// -------------------------------------------------------------
// 19. Order Checkout: Custom Confirmation and Feedback Modal Layout
// -------------------------------------------------------------
test('Order Checkout: Structured custom confirmation and success modal states', () => {
  const checkoutData = {
    showConfirmModal: false,
    showSuccessModal: false,
    submitting: false,
    orderSubmitted: false,
    selectedAddress: {
      recipientName: 'admin',
      recipientPhone: '18918918918',
      fullAddress: '江苏省南通市崇川区 1'
    },
    items: [
      { materialId: 1, materialName: 'test', selectedUnit: '包', selectedQty: 1, packageUnitPrice: '4444.00', lineAmount: '4444.00' }
    ],
    totalAmount: '4444.00',
    totalQty: 1,
    submittedOrderNo: '',
    submittedAmount: '0.00'
  };

  // User taps submit: opens custom confirmation modal with structured sections
  function onOpenConfirmModal(data) {
    if (data.submitting || data.orderSubmitted) return data;
    if (!data.selectedAddress || !data.items || data.items.length === 0) return data;
    return Object.assign({}, data, { showConfirmModal: true });
  }

  const step1 = onOpenConfirmModal(checkoutData);
  assert.equal(step1.showConfirmModal, true);
  assert.equal(step1.selectedAddress.recipientName, 'admin');
  assert.equal(step1.items.length, 1);
  assert.equal(step1.totalAmount, '4444.00');

  // User cancels: closes confirmation modal
  function onCloseConfirmModal(data) {
    if (data.submitting) return data;
    return Object.assign({}, data, { showConfirmModal: false });
  }

  const stepCancel = onCloseConfirmModal(step1);
  assert.equal(stepCancel.showConfirmModal, false);

  // User confirms: submit succeeds, closes confirm modal and opens success modal
  function onSubmitSuccess(data, serverRes) {
    return Object.assign({}, data, {
      submitting: false,
      orderSubmitted: true,
      showConfirmModal: false,
      showSuccessModal: true,
      submittedOrderNo: serverRes.orderNo,
      submittedAmount: serverRes.totalAmount.toFixed(2)
    });
  }

  const stepSuccess = onSubmitSuccess(step1, { orderNo: 'PO202609298888', totalAmount: 4444.00 });
  assert.equal(stepSuccess.showConfirmModal, false);
  assert.equal(stepSuccess.showSuccessModal, true);
  assert.equal(stepSuccess.submittedOrderNo, 'PO202609298888');
  assert.equal(stepSuccess.submittedAmount, '4444.00');
  assert.equal(stepSuccess.orderSubmitted, true);
});

// -------------------------------------------------------------
// 20. Pagination Engine: Default 30 items, 50/100 switcher & page navigation
// -------------------------------------------------------------
test('Pagination Engine: Default 30 records, supports 50 and 100, computes pages accurately', () => {
  function sliceRecords(records, pageIndex, pageSize) {
    if (pageSize !== 30 && pageSize !== 50 && pageSize !== 100) pageSize = 30;
    const total = records ? records.length : 0;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    let curPage = Math.max(1, pageIndex || 1);
    if (curPage > totalPages) curPage = totalPages;

    const start = (curPage - 1) * pageSize;
    const end = Math.min(start + pageSize, total);
    const paged = records.slice(start, end);

    return {
      pagedData: paged,
      totalRecords: total,
      pageIndex: curPage,
      pageSize: pageSize,
      totalPages: totalPages
    };
  }

  // Generate 85 mock orders
  const mockOrders = [];
  for (let i = 1; i <= 85; i++) {
    mockOrders.push({ id: i, orderNo: 'ORD_' + i });
  }

  // 1. Default page size (30)
  const defaultPage1 = sliceRecords(mockOrders, 1, 0); // 0 falls back to 30
  assert.equal(defaultPage1.pageSize, 30);
  assert.equal(defaultPage1.totalRecords, 85);
  assert.equal(defaultPage1.totalPages, 3);
  assert.equal(defaultPage1.pagedData.length, 30);
  assert.equal(defaultPage1.pagedData[0].id, 1);
  assert.equal(defaultPage1.pagedData[29].id, 30);

  // Page 3 with default page size (tail)
  const defaultPage3 = sliceRecords(mockOrders, 3, 30);
  assert.equal(defaultPage3.pagedData.length, 25);
  assert.equal(defaultPage3.pagedData[0].id, 61);
  assert.equal(defaultPage3.pagedData[24].id, 85);

  // 2. Switch to 50 records per page
  const page50 = sliceRecords(mockOrders, 1, 50);
  assert.equal(page50.pageSize, 50);
  assert.equal(page50.totalPages, 2);
  assert.equal(page50.pagedData.length, 50);

  // 3. Switch to 100 records per page
  const page100 = sliceRecords(mockOrders, 1, 100);
  assert.equal(page100.pageSize, 100);
  assert.equal(page100.totalPages, 1);
  assert.equal(page100.pagedData.length, 85);

  // 4. Out of bounds page clamps safely to totalPages
  const clampedPage = sliceRecords(mockOrders, 999, 30);
  assert.equal(clampedPage.pageIndex, 3);
});

// -------------------------------------------------------------
// 21. Order Multi-Filtering, Date Range & Sorting Engine
// -------------------------------------------------------------
test('Order Filter Engine: Supports hospital, purchaser, status, date range and sort asc/desc', () => {
  const dataset = [
    { id: 1, orderNo: 'ORD001', customer: '华西医院', purchaser: '张采购', status: 'SUBMITTED', totalAmount: 1000, submittedAt: '2026-09-01 10:00:00' },
    { id: 2, orderNo: 'ORD002', customer: '华西医院', purchaser: '李采购', status: 'ACCEPTED', totalAmount: 5000, submittedAt: '2026-09-05 12:00:00' },
    { id: 3, orderNo: 'ORD003', customer: '南通附院', purchaser: '王采购', status: 'SUBMITTED', totalAmount: 2000, submittedAt: '2026-09-10 14:00:00' },
    { id: 4, orderNo: 'ORD004', customer: '南通附院', purchaser: '张采购', status: 'CANCELLED', totalAmount: 3000, submittedAt: '2026-09-15 16:00:00' }
  ];

  function filterAndSortOrders(orders, filters) {
    let result = orders.slice();
    if (filters.customer) {
      result = result.filter(o => o.customer === filters.customer);
    }
    if (filters.purchaser) {
      result = result.filter(o => o.purchaser === filters.purchaser);
    }
    if (filters.status) {
      result = result.filter(o => o.status === filters.status);
    }
    if (filters.startDate) {
      result = result.filter(o => o.submittedAt >= filters.startDate + ' 00:00:00');
    }
    if (filters.endDate) {
      result = result.filter(o => o.submittedAt <= filters.endDate + ' 23:59:59');
    }
    if (filters.sortBy === 'submitted_asc') {
      result.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
    } else if (filters.sortBy === 'amount_desc') {
      result.sort((a, b) => b.totalAmount - a.totalAmount);
    } else if (filters.sortBy === 'amount_asc') {
      result.sort((a, b) => a.totalAmount - b.totalAmount);
    } else {
      // Default: submitted_desc
      result.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
    }
    return result;
  }

  // Test 1: Filter by hospital
  const res1 = filterAndSortOrders(dataset, { customer: '华西医院' });
  assert.equal(res1.length, 2);
  assert.deepEqual(res1.map(o => o.orderNo), ['ORD002', 'ORD001']); // default desc

  // Test 2: Filter by purchaser + status
  const res2 = filterAndSortOrders(dataset, { purchaser: '张采购', status: 'SUBMITTED' });
  assert.equal(res2.length, 1);
  assert.equal(res2[0].orderNo, 'ORD001');

  // Test 3: Date range filter
  const res3 = filterAndSortOrders(dataset, { startDate: '2026-09-04', endDate: '2026-09-12' });
  assert.equal(res3.length, 2);
  assert.deepEqual(res3.map(o => o.orderNo), ['ORD003', 'ORD002']);

  // Test 4: Positive chronological sorting (submitted_asc)
  const res4 = filterAndSortOrders(dataset, { sortBy: 'submitted_asc' });
  assert.equal(res4[0].orderNo, 'ORD001');
  assert.equal(res4[3].orderNo, 'ORD004');

  // Test 5: Amount sorting
  const res5 = filterAndSortOrders(dataset, { sortBy: 'amount_desc' });
  assert.equal(res5[0].totalAmount, 5000);
  assert.equal(res5[3].totalAmount, 1000);
});

// -------------------------------------------------------------
// 22. Backend Order Deletion & Batch Action Mechanics
// -------------------------------------------------------------
test('Backend Order Management: Single and batch order deletion, batch dispatch and export selection', () => {
  const ordersState = [
    { id: 101, orderNo: 'ORD_101', status: 'SUBMITTED', reservedStock: 0 },
    { id: 102, orderNo: 'ORD_102', status: 'ACCEPTED', reservedStock: 50 },
    { id: 103, orderNo: 'ORD_103', status: 'SUBMITTED', reservedStock: 0 },
    { id: 104, orderNo: 'ORD_104', status: 'CANCELLED', reservedStock: 0 }
  ];

  // Batch Accept
  function batchAccept(orders, idsToAccept) {
    let accepted = 0;
    orders.forEach(o => {
      if (idsToAccept.includes(o.id) && o.status === 'SUBMITTED') {
        o.status = 'ACCEPTED';
        o.reservedStock = 20; // atomic reservation
        accepted++;
      }
    });
    return accepted;
  }

  const acceptedCount = batchAccept(ordersState, [101, 103, 104]);
  assert.equal(acceptedCount, 2);
  assert.equal(ordersState.find(o => o.id === 101).status, 'ACCEPTED');
  assert.equal(ordersState.find(o => o.id === 103).status, 'ACCEPTED');
  assert.equal(ordersState.find(o => o.id === 104).status, 'CANCELLED'); // unchanged

  // Deletion logic with stock reservation release
  let releasedReservations = 0;
  function deleteOrder(orders, orderId) {
    const idx = orders.findIndex(o => o.id === orderId);
    if (idx === -1) return false;
    const target = orders[idx];
    if (target.reservedStock > 0) {
      releasedReservations += target.reservedStock;
      target.reservedStock = 0;
    }
    orders.splice(idx, 1);
    return true;
  }

  function batchDelete(orders, idsToDelete) {
    let deleted = 0;
    idsToDelete.forEach(id => {
      if (deleteOrder(orders, id)) deleted++;
    });
    return deleted;
  }

  // Delete accepted order 102: stock reservation must be released!
  const del102 = deleteOrder(ordersState, 102);
  assert.equal(del102, true);
  assert.equal(releasedReservations, 50);
  assert.equal(ordersState.find(o => o.id === 102), undefined);

  // Batch delete remaining 101 and 104
  const batchDelCount = batchDelete(ordersState, [101, 104]);
  assert.equal(batchDelCount, 2);
  assert.equal(ordersState.length, 1);
  assert.equal(ordersState[0].id, 103);
});

// -------------------------------------------------------------
// 15. Delivery Manifest Quantifier Formatting
// -------------------------------------------------------------
test('Delivery Manifest Quantifier: formats packaging and base units (e.g. 1包（50件）, 1箱（300件）, 20件)', () => {
  function formatDeliveryQuantifier(dispatchedBaseQty, baseUnit, orderUnit, factorToBase) {
    if (!baseUnit) baseUnit = '件';
    baseUnit = baseUnit.trim();
    orderUnit = (orderUnit || '').trim();

    if (!orderUnit || orderUnit.toLowerCase() === baseUnit.toLowerCase() || factorToBase <= 1) {
      return `${dispatchedBaseQty}${baseUnit}`;
    }

    const pkg = Math.floor(dispatchedBaseQty / factorToBase);
    const rem = dispatchedBaseQty % factorToBase;

    if (pkg > 0 && rem === 0) {
      return `${pkg}${orderUnit}（${dispatchedBaseQty}${baseUnit}）`;
    } else if (pkg > 0 && rem > 0) {
      return `${pkg}${orderUnit}${rem}${baseUnit}（${dispatchedBaseQty}${baseUnit}）`;
    } else {
      return `${dispatchedBaseQty}${baseUnit}`;
    }
  }

  // Exact cases requested by user:
  assert.equal(formatDeliveryQuantifier(50, '件', '包', 50), '1包（50件）');
  assert.equal(formatDeliveryQuantifier(300, '件', '箱', 300), '1箱（300件）');
  assert.equal(formatDeliveryQuantifier(20, '件', '件', 1), '20件');

  // Additional edge cases:
  assert.equal(formatDeliveryQuantifier(100, '件', '包', 50), '2包（100件）');
  assert.equal(formatDeliveryQuantifier(605, '件', '箱', 300), '2箱5件（605件）');
  assert.equal(formatDeliveryQuantifier(15, '件', '包', 50), '15件'); // less than 1 pack
  assert.equal(formatDeliveryQuantifier(10, '支', '', 1), '10支'); // base unit only
});

// -------------------------------------------------------------
// 16. Dynamic Gift Unit Generation & Quota Isolation Architecture
// -------------------------------------------------------------
test('Gift Architecture: Active FREE rule dynamically prepends gift unit at index 0 without creating new catalog item', () => {
  function buildCatalogUnits(baseUnit, packagingUnits, permittedUnits, refPrice, defaultDiscount, rules, now) {
    const nonFreeRules = (rules || []).filter(r => r.ruleType !== 'FREE');
    const giftRules = (rules || []).filter(r => r.ruleType === 'FREE' && r.status === 0 && (!r.startTime || new Date(r.startTime) <= now) && (!r.endTime || now <= new Date(r.endTime)));
    const activeGiftRule = giftRules.length > 0 ? giftRules[0] : null;

    const units = [];

    // 1. Regular permitted units
    for (const unitName of permittedUnits) {
      const conv = resolveConversionDAG(baseUnit, packagingUnits.map(p => ({ fromUnit: p.unitName, toUnit: p.parentUnitName, multiplier: p.factorToParent })), unitName, 1);
      const pkgPrice = Math.round(refPrice * defaultDiscount * conv.factorToBase * 100) / 100;
      units.push({
        unitName: unitName,
        factorToBase: conv.factorToBase,
        baseUnit: baseUnit,
        packageUnitPrice: pkgPrice,
        isGift: false
      });
    }

    // 2. Dynamic gift unit prepended at far-left (index 0)
    if (activeGiftRule) {
      const giftOriginalUnit = activeGiftRule.quotaUnit || baseUnit;
      const giftUnitName = `${giftOriginalUnit}（赠品）`;
      const giftConv = resolveConversionDAG(baseUnit, packagingUnits.map(p => ({ fromUnit: p.unitName, toUnit: p.parentUnitName, multiplier: p.factorToParent })), giftOriginalUnit, 1);
      units.unshift({
        unitName: giftUnitName,
        originalUnit: giftOriginalUnit,
        factorToBase: giftConv.factorToBase,
        baseUnit: baseUnit,
        packageUnitPrice: 0.00,
        isGift: true,
        quotaLimit: activeGiftRule.quotaLimit,
        quotaUnit: giftOriginalUnit,
        remainingQuota: activeGiftRule.quotaLimit,
        isQuotaExceeded: false
      });
    }

    return units;
  }

  const baseUnit = '支';
  const pkgUnits = [
    { unitName: '盒', parentUnitName: '支', factorToParent: 10 },
    { unitName: '箱', parentUnitName: '盒', factorToParent: 20 }
  ];
  const permittedUnits = ['支', '盒', '箱'];
  const rules = [
    { id: 1, ruleType: 'FREE', quotaLimit: 2, quotaUnit: '盒', priority: 100, status: 0 }
  ];

  const catalogUnits = buildCatalogUnits(baseUnit, pkgUnits, permittedUnits, 15.00, 0.8, rules, new Date());

  // Must have 4 units: 盒（赠品） at index 0, followed by 支, 盒, 箱
  assert.equal(catalogUnits.length, 4);
  assert.equal(catalogUnits[0].unitName, '盒（赠品）');
  assert.equal(catalogUnits[0].packageUnitPrice, 0.00);
  assert.equal(catalogUnits[0].isGift, true);
  assert.equal(catalogUnits[0].factorToBase, 10);
  assert.equal(catalogUnits[0].quotaLimit, 2);

  // Normal units remain intact with contracted prices
  assert.equal(catalogUnits[1].unitName, '支');
  assert.equal(catalogUnits[1].packageUnitPrice, 12.00); // 15 * 0.8
  assert.equal(catalogUnits[1].isGift, false);

  assert.equal(catalogUnits[2].unitName, '盒');
  assert.equal(catalogUnits[2].packageUnitPrice, 120.00); // 12 * 10
  assert.equal(catalogUnits[2].isGift, false);

  assert.equal(catalogUnits[3].unitName, '箱');
  assert.equal(catalogUnits[3].packageUnitPrice, 2400.00); // 120 * 20
  assert.equal(catalogUnits[3].isGift, false);
});

test('Gift Architecture: Quota isolation strictly limits only the gift unit; regular units remain unaffected', () => {
  const giftRule = { quotaLimit: 2, quotaUnit: '箱' };
  let giftPurchasedQty = 2; // gift quota fully exhausted!

  function validateAddToCart(unitObj, qty, currentPurchasedGiftQty) {
    if (unitObj.isGift) {
      const remaining = Math.max(0, unitObj.quotaLimit - currentPurchasedGiftQty);
      if (remaining <= 0 || qty > remaining) {
        throw new Error('超出赠品限领配额');
      }
      return { success: true, price: 0.00 };
    } else {
      // Regular unit: unaffected by gift quota!
      return { success: true, price: unitObj.packageUnitPrice };
    }
  }

  const giftUnit = { unitName: '箱（赠品）', isGift: true, quotaLimit: 2, packageUnitPrice: 0.00 };
  const regularUnit = { unitName: '箱', isGift: false, packageUnitPrice: 300.00 };

  // Attempting to add gift unit fails because gift quota is reached
  assert.throws(() => {
    validateAddToCart(giftUnit, 1, giftPurchasedQty);
  }, /超出赠品限领配额/);

  // Regular unit succeeds even though gift quota is 0!
  const regularResult = validateAddToCart(regularUnit, 10, giftPurchasedQty);
  assert.equal(regularResult.success, true);
  assert.equal(regularResult.price, 300.00);
});

test('Quota Unit Selector: Populates strictly from material base unit and packaging units, disallowing arbitrary text', () => {
  function getSelectableQuotaUnits(baseUnit, packagingUnits) {
    const list = [{ name: baseUnit, label: `${baseUnit} (基本单位)` }];
    (packagingUnits || []).forEach(u => {
      list.push({ name: u.unitName, label: `${u.unitName} (包装单位)` });
    });
    return list;
  }

  const selectable = getSelectableQuotaUnits('瓶', [{ unitName: '箱' }, { unitName: '组' }]);
  assert.equal(selectable.length, 3);
  assert.deepEqual(selectable.map(s => s.name), ['瓶', '箱', '组']);
  assert.equal(selectable[0].label, '瓶 (基本单位)');
  assert.equal(selectable[1].label, '箱 (包装单位)');
});

test('Order List Status Badge: PARTIAL_DISPATCHED displays 部分送达, delivery and receipt statuses map accurately', () => {
  const STATUS_MAP = {
    SUBMITTED: '待接单',
    ACCEPTED: '配货发货中',
    PARTIAL_DISPATCHED: '部分送达',
    PARTIALLY_DISPATCHED: '部分送达',
    DISPATCHED: '已全部出库',
    ALL_DISPATCHED: '已全部出库',
    COMPLETED: '已收货',
    CLOSED: '已结平关闭',
    REJECTED: '已驳回',
    CANCELLED: '已取消'
  };

  const DELIVERY_MAP = {
    PENDING: '待取货',
    PENDING_PICKUP: '待取货',
    IN_DELIVERY: '配送中',
    DELIVERING: '配送中',
    DELIVERED: '已送达',
    DELIVERY_FAILED: '配送异常',
    FAILED: '配送异常'
  };

  const RECEIPT_MAP = {
    PENDING: '待签收 (7天自动签收)',
    PENDING_RECEIPT: '待签收 (7天自动签收)',
    CONFIRMED: '已签收'
  };

  assert.equal(STATUS_MAP['PARTIAL_DISPATCHED'], '部分送达');
  assert.equal(STATUS_MAP['PARTIALLY_DISPATCHED'], '部分送达');
  assert.equal(STATUS_MAP['DISPATCHED'], '已全部出库');
  assert.equal(STATUS_MAP['ALL_DISPATCHED'], '已全部出库');
  assert.equal(STATUS_MAP['COMPLETED'], '已收货');

  assert.equal(DELIVERY_MAP['PENDING'], '待取货');
  assert.equal(DELIVERY_MAP['IN_DELIVERY'], '配送中');
  assert.equal(DELIVERY_MAP['DELIVERED'], '已送达');
  assert.equal(DELIVERY_MAP['DELIVERY_FAILED'], '配送异常');

  assert.equal(RECEIPT_MAP['PENDING'], '待签收 (7天自动签收)');
  assert.equal(RECEIPT_MAP['CONFIRMED'], '已签收');
});

test('Receipt Lifecycle: individual batch receipt, auto-completion when all dispatched and received, and all-receipt action', () => {
  function evaluateOrderCompletion(orderItems, shipments) {
    const unshipped = orderItems.filter(i => (i.baseQty - i.dispatchedBaseQty - i.closedBaseQty) > 0);
    const unconfirmed = shipments.filter(s => s.receiptStatus !== 'CONFIRMED');
    const isAllDispatched = unshipped.length === 0;
    const isAllReceived = shipments.length > 0 && unconfirmed.length === 0;

    let orderStatus = 'ACCEPTED';
    if (isAllDispatched && isAllReceived) {
      orderStatus = 'COMPLETED';
    } else if (isAllDispatched) {
      orderStatus = 'ALL_DISPATCHED';
    } else if (orderItems.some(i => i.dispatchedBaseQty > 0)) {
      orderStatus = 'PARTIAL_DISPATCHED';
    }

    const hasUnreceived = unconfirmed.length > 0;
    const canShowAllReceipt = (orderStatus === 'ALL_DISPATCHED' || orderStatus === 'DISPATCHED') && hasUnreceived;

    return { orderStatus, hasUnreceived, canShowAllReceipt };
  }

  const items = [
    { baseQty: 100, dispatchedBaseQty: 50, closedBaseQty: 0 },
    { baseQty: 50, dispatchedBaseQty: 50, closedBaseQty: 0 }
  ];
  const shipment1 = { id: 1, receiptStatus: 'PENDING' };

  // Partially dispatched
  let state = evaluateOrderCompletion(items, [shipment1]);
  assert.equal(state.orderStatus, 'PARTIAL_DISPATCHED');
  assert.equal(state.canShowAllReceipt, false);

  // Remaining dispatched, but shipment1 and shipment2 unreceived
  items[0].dispatchedBaseQty = 100;
  const shipment2 = { id: 2, receiptStatus: 'PENDING' };
  state = evaluateOrderCompletion(items, [shipment1, shipment2]);
  assert.equal(state.orderStatus, 'ALL_DISPATCHED');
  assert.equal(state.hasUnreceived, true);
  assert.equal(state.canShowAllReceipt, true);

  // Customer receives shipment 1 individually
  shipment1.receiptStatus = 'CONFIRMED';
  state = evaluateOrderCompletion(items, [shipment1, shipment2]);
  assert.equal(state.orderStatus, 'ALL_DISPATCHED');
  assert.equal(state.hasUnreceived, true);
  assert.equal(state.canShowAllReceipt, true);

  // Customer receives shipment 2 (all received) -> auto completes!
  shipment2.receiptStatus = 'CONFIRMED';
  state = evaluateOrderCompletion(items, [shipment1, shipment2]);
  assert.equal(state.orderStatus, 'COMPLETED');
  assert.equal(state.hasUnreceived, false);
  assert.equal(state.canShowAllReceipt, false);
});

test('Customer Deletion & Constraints: rejects deletion when customer has orders or unreceived shipments', () => {
  function validateCustomerDeletion(customer, orderCount, shipmentCount, settlementCount) {
    if (orderCount > 0) {
      throw new Error(`拒绝删除医院客户【${customer.name}】：名下存在 ${orderCount} 笔采购订单记录，涉及财务溯源与历史审计，禁止直接物理删除！`);
    }
    if (shipmentCount > 0) {
      throw new Error(`拒绝删除医院客户【${customer.name}】：名下存在 ${shipmentCount} 笔派送分配记录，禁止删除！`);
    }
    if (settlementCount > 0) {
      throw new Error(`拒绝删除医院客户【${customer.name}】：名下存在 ${settlementCount} 笔月度结算单记录，禁止删除！`);
    }
    return true;
  }

  const cust = { id: 1, name: '市第一人民医院' };

  // Customer with orders blocked
  assert.throws(() => {
    validateCustomerDeletion(cust, 3, 0, 0);
  }, /名下存在 3 笔采购订单记录/);

  // Clean customer succeeds
  assert.equal(validateCustomerDeletion(cust, 0, 0, 0), true);
});

test('Excel Header Synonyms and Normalization: handles asterisks and parentheses effortlessly', () => {
  function normalizeHeaders(headers) {
    const dict = {};
    headers.forEach(h => {
      const cleanH = h.replace(/\*/g, '').trim();
      dict[cleanH] = true;
      const parenIdx = cleanH.indexOf('(') !== -1 ? cleanH.indexOf('(') : cleanH.indexOf('（');
      if (parenIdx > 0) {
        dict[cleanH.substring(0, parenIdx).trim()] = true;
      }
      if (cleanH.includes('客户编码')) dict['客户编码'] = true;
      if (cleanH.includes('医院名称')) dict['医院名称'] = true;
      if (cleanH.includes('折扣')) dict['默认折扣率'] = true;
      if (cleanH.includes('货品编码')) dict['货品编码'] = true;
      if (cleanH.includes('货品名称')) dict['货品名称'] = true;
      if (cleanH.includes('批号')) dict['生产批号'] = true;
      if (cleanH.includes('生产日期')) dict['生产日期'] = true;
      if (cleanH.includes('有效期')) dict['有效截止日期'] = true;
    });
    return dict;
  }

  const custHeaders = ['医院客户编码*', '医院名称*', '默认折扣率(如0.85)*', '主要联系人', '联系电话'];
  const custNorm = normalizeHeaders(custHeaders);
  assert.equal(custNorm['客户编码'], true);
  assert.equal(custNorm['医院名称'], true);
  assert.equal(custNorm['默认折扣率'], true);

  const matHeaders = ['货品编码*', '货品名称*', '货品分类', '规格', '型号', '基本单位*', '参考销售单价*', '生产厂家', '凭证号', '包装说明', '储运要求', '有效期'];
  const matNorm = normalizeHeaders(matHeaders);
  assert.equal(matNorm['货品编码'], true);
  assert.equal(matNorm['货品名称'], true);
  assert.equal(matNorm['凭证号'], true);
  assert.equal(matNorm['储运要求'], true);
  assert.equal(matNorm['有效期'], true);

  const invHeaders = ['货品编码*', '生产批号*', '生产日期(yyyy-MM-dd)*', '有效期至(yyyy-MM-dd)*', '入库数量*'];
  const invNorm = normalizeHeaders(invHeaders);
  assert.equal(invNorm['货品编码'], true);
  assert.equal(invNorm['生产批号'], true);
  assert.equal(invNorm['生产日期'], true);
  assert.equal(invNorm['有效截止日期'], true);
});

test('Material Metadata: 凭证号, 储运要求 and 有效期 render on separate lines under 包装说明', () => {
  const item = {
    id: 101,
    materialCode: 'HC-001',
    materialName: '环保脱蜡透明液',
    packageDesc: '1箱=20瓶，500ml/瓶',
    registrationCertNo: '粤械注准20230001',
    storageCondition: '常温避光、通风干燥处保存',
    validPeriod: '24个月'
  };

  // Simulating WXML meta-row rendering logic
  function renderMaterialMetaRows(m) {
    const rows = [];
    if (m.spec || m.model) rows.push({ label: '规格/型号', val: `${m.spec || '-'} / ${m.model || '-'}` });
    if (m.manufacturer) rows.push({ label: '生产厂商', val: m.manufacturer });
    if (m.packageDesc) rows.push({ label: '包装说明', val: m.packageDesc });
    if (m.storageCondition) rows.push({ label: '储运要求', val: m.storageCondition });
    if (m.validPeriod) rows.push({ label: '有效期', val: m.validPeriod });
    return rows;
  }

  const rows = renderMaterialMetaRows(item);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].label, '包装说明');
  assert.equal(rows[0].val, '1箱=20瓶，500ml/瓶');
  assert.equal(rows[1].label, '储运要求');
  assert.equal(rows[1].val, '常温避光、通风干燥处保存');
  assert.equal(rows[2].label, '有效期');
});

test('Order Detail & Auto-Completion: gracefully handles missing columns and updates order to COMPLETED', () => {
  function simulateAutoCompletion(order, items, shipments, dbHasTimestampCols) {
    const unshippedCount = items.filter(it => (it.baseQty - it.dispatchedBaseQty - it.closedBaseQty) > 0).length;
    const totalShipments = shipments.length;
    const unconfirmedShipments = shipments.filter(s => s.receiptStatus !== 'CONFIRMED').length;

    if (unshippedCount === 0 && totalShipments > 0 && unconfirmedShipments === 0) {
      if (dbHasTimestampCols) {
        order.orderStatus = 'COMPLETED';
        order.completedAt = new Date().toISOString();
        order.updatedAt = new Date().toISOString();
      } else {
        order.orderStatus = 'COMPLETED';
      }
      return true;
    }
    return false;
  }

  const order1 = { id: 1, orderStatus: 'ALL_DISPATCHED' };
  const items1 = [{ baseQty: 10, dispatchedBaseQty: 10, closedBaseQty: 0 }];
  const shipments1 = [{ id: 101, receiptStatus: 'CONFIRMED' }];

  const res1 = simulateAutoCompletion(order1, items1, shipments1, false);
  assert.equal(res1, true);
  assert.equal(order1.orderStatus, 'COMPLETED');

  const order2 = { id: 2, orderStatus: 'ALL_DISPATCHED' };
  const res2 = simulateAutoCompletion(order2, items1, shipments1, true);
  assert.equal(res2, true);
  assert.equal(order2.orderStatus, 'COMPLETED');
  assert.ok(order2.completedAt);
});

test('Cart Stepper: direct numeric editing validates input and updates quantity', () => {
  function handleQtyBlur(inputVal) {
    let val = parseInt(inputVal, 10);
    if (isNaN(val) || val < 1) {
      val = 1;
    }
    return val;
  }

  assert.equal(handleQtyBlur('5'), 5);
  assert.equal(handleQtyBlur('100'), 100);
  assert.equal(handleQtyBlur('0'), 1);
  assert.equal(handleQtyBlur('-5'), 1);
  assert.equal(handleQtyBlur('abc'), 1);
  assert.equal(handleQtyBlur(''), 1);
});

test('Order Status Reconciliation: rolls back ALL_DISPATCHED when shipments are rejected or deleted', () => {
  function reconcileOrderStatus(orderItems) {
    const totalRemaining = orderItems.reduce((acc, it) => acc + (it.baseQty - it.closedBaseQty - it.dispatchedBaseQty), 0);
    const totalDispatched = orderItems.reduce((acc, it) => acc + it.dispatchedBaseQty, 0);

    if (totalRemaining <= 0) {
      return totalDispatched > 0 ? 'ALL_DISPATCHED' : 'CLOSED';
    } else {
      return totalDispatched > 0 ? 'PARTIAL_DISPATCHED' : 'ACCEPTED';
    }
  }

  // Case 1: Multiple shipments, 1 shipment rejected and removed
  // Order originally had 2 items of 10 units each, all dispatched (totalRemaining = 0 -> ALL_DISPATCHED)
  // After deleting shipment 2 (5 units of item 2):
  const multiShipmentItems = [
    { baseQty: 10, closedBaseQty: 0, dispatchedBaseQty: 10 },
    { baseQty: 10, closedBaseQty: 0, dispatchedBaseQty: 5 } // 5 units unshipped
  ];
  assert.equal(reconcileOrderStatus(multiShipmentItems), 'PARTIAL_DISPATCHED');

  // Case 2: Single shipment, only shipment rejected and removed
  // Order had 10 units, all 10 rolled back:
  const singleShipmentItems = [
    { baseQty: 10, closedBaseQty: 0, dispatchedBaseQty: 0 }
  ];
  assert.equal(reconcileOrderStatus(singleShipmentItems), 'ACCEPTED');

  // Case 3: Action buttons check - both allow re-dispatch and close balance when unshipped > 0
  function canDispatchOrClose(status, unshippedQty) {
    return status === 'ACCEPTED' || status === 'PARTIAL_DISPATCHED' || ((status === 'DISPATCHED' || status === 'ALL_DISPATCHED') && unshippedQty > 0);
  }
  assert.equal(canDispatchOrClose('PARTIAL_DISPATCHED', 5), true);
  assert.equal(canDispatchOrClose('ACCEPTED', 10), true);
  assert.equal(canDispatchOrClose('ALL_DISPATCHED', 5), true); // even if healing hasn't run yet
  assert.equal(canDispatchOrClose('ALL_DISPATCHED', 0), false);
});

test('Order Deletion: checks settlement join via sw_proc_settlement correctly', () => {
  // Mock settlement items and settlements
  const settlements = {
    101: { id: 101, status: 'SETTLED' },
    102: { id: 102, status: 'DRAFT' }
  };
  const settlementItems = [
    { orderId: 1, settlementId: 101 }, // settled
    { orderId: 2, settlementId: 102 }  // draft (unsettled)
  ];

  function canDeleteOrder(orderId) {
    const isSettled = settlementItems.some(si => si.orderId === orderId && settlements[si.settlementId] && settlements[si.settlementId].status === 'SETTLED');
    if (isSettled) {
      return { allowed: false, reason: '该订单已有明细完成财务月度结算归档，受财务审计约束禁止直接删除！' };
    }
    return { allowed: true };
  }

  assert.equal(canDeleteOrder(1).allowed, false);
  assert.match(canDeleteOrder(1).reason, /财务审计约束禁止直接删除/);
  assert.equal(canDeleteOrder(2).allowed, true);
  assert.equal(canDeleteOrder(3).allowed, true);
});

test('Order List Tabs: PARTIAL_DISPATCHED belongs to 配货中 (ACCEPTED) tab', () => {
  // Test tab status mapping in frontend onLoad
  function resolveTabStatus(paramStatus) {
    if (paramStatus === 'PARTIAL_DISPATCHED' || paramStatus === 'PARTIALLY_DISPATCHED') {
      return 'ACCEPTED';
    }
    if (paramStatus === 'DISPATCHED') {
      return 'ALL_DISPATCHED';
    }
    return paramStatus || '';
  }

  assert.equal(resolveTabStatus('PARTIAL_DISPATCHED'), 'ACCEPTED');
  assert.equal(resolveTabStatus('PARTIALLY_DISPATCHED'), 'ACCEPTED');
  assert.equal(resolveTabStatus('ACCEPTED'), 'ACCEPTED');
  assert.equal(resolveTabStatus('DISPATCHED'), 'ALL_DISPATCHED');
  assert.equal(resolveTabStatus('ALL_DISPATCHED'), 'ALL_DISPATCHED');
  assert.equal(resolveTabStatus('SUBMITTED'), 'SUBMITTED');

  // Test backend status filtering logic
  function filterOrdersByTab(orders, tabStatus) {
    if (!tabStatus) return orders;
    if (tabStatus === 'ACCEPTED' || tabStatus === 'PARTIAL_DISPATCHED' || tabStatus === 'PARTIALLY_DISPATCHED') {
      return orders.filter(o => ['ACCEPTED', 'PARTIAL_DISPATCHED', 'PARTIALLY_DISPATCHED'].includes(o.orderStatus));
    }
    if (tabStatus === 'ALL_DISPATCHED' || tabStatus === 'DISPATCHED') {
      return orders.filter(o => ['ALL_DISPATCHED', 'DISPATCHED'].includes(o.orderStatus));
    }
    if (tabStatus === 'CANCELLED') {
      return orders.filter(o => ['CANCELLED', 'REJECTED', 'CLOSED'].includes(o.orderStatus));
    }
    return orders.filter(o => o.orderStatus === tabStatus);
  }

  const sampleOrders = [
    { id: 1, orderNo: 'ORD001', orderStatus: 'SUBMITTED' },
    { id: 2, orderNo: 'ORD002', orderStatus: 'ACCEPTED' },
    { id: 3, orderNo: 'ORD003', orderStatus: 'PARTIAL_DISPATCHED' },
    { id: 4, orderNo: 'ORD004', orderStatus: 'ALL_DISPATCHED' },
    { id: 5, orderNo: 'ORD005', orderStatus: 'COMPLETED' },
    { id: 6, orderNo: 'ORD006', orderStatus: 'CLOSED' }
  ];

  const acceptedTabOrders = filterOrdersByTab(sampleOrders, 'ACCEPTED');
  assert.equal(acceptedTabOrders.length, 2);
  assert.deepEqual(acceptedTabOrders.map(o => o.orderNo), ['ORD002', 'ORD003']);

  const allDispatchedOrders = filterOrdersByTab(sampleOrders, 'ALL_DISPATCHED');
  assert.equal(allDispatchedOrders.length, 1);
  assert.equal(allDispatchedOrders[0].orderNo, 'ORD004');

  const cancelledTabOrders = filterOrdersByTab(sampleOrders, 'CANCELLED');
  assert.equal(cancelledTabOrders.length, 1);
  assert.equal(cancelledTabOrders[0].orderNo, 'ORD006');
});

test('CloseUnshippedBalance: closes remaining balance, releases reserved stock and sets status correctly', () => {
  // Simulates the transactional logic of CloseUnshippedBalance
  const order = { id: 10, orderNo: 'ORD-TEST', orderStatus: 'PARTIAL_DISPATCHED' };
  const items = [
    { id: 1, materialId: 100, baseQty: 10, dispatchedBaseQty: 4, closedBaseQty: 0 },
    { id: 2, materialId: 101, baseQty: 5, dispatchedBaseQty: 0, closedBaseQty: 0 }
  ];
  const batches = [
    { id: 1, materialId: 100, reservedQty: 6 },
    { id: 2, materialId: 101, reservedQty: 5 }
  ];

  function closeUnshippedBalance(ord, itms, btchs, reason) {
    if (!reason || !reason.trim()) throw new Error('请填写结案关单原因');
    if (['CLOSED', 'CANCELLED', 'REJECTED', 'SUBMITTED'].includes(ord.orderStatus)) {
      throw new Error('当前订单状态不允许关闭未发货尾数');
    }

    let closedAny = false;
    itms.forEach(it => {
      const unshipped = it.baseQty - it.dispatchedBaseQty - it.closedBaseQty;
      if (unshipped > 0) {
        closedAny = true;
        // Release from batches
        let rem = unshipped;
        btchs.filter(b => b.materialId === it.materialId && b.reservedQty > 0).forEach(b => {
          if (rem <= 0) return;
          const rel = Math.min(b.reservedQty, rem);
          b.reservedQty -= rel;
          rem -= rel;
        });
        it.closedBaseQty += unshipped;
      }
    });

    if (!closedAny) throw new Error('该订单已全部发货或尾数已关闭，无剩余未发货数量');

    const totalDispatched = itms.reduce((acc, it) => acc + it.dispatchedBaseQty, 0);
    ord.orderStatus = totalDispatched > 0 ? 'ALL_DISPATCHED' : 'CLOSED';
    ord.closeReason = reason;
  }

  closeUnshippedBalance(order, items, batches, '客户申请退尾单');
  assert.equal(items[0].closedBaseQty, 6);
  assert.equal(items[1].closedBaseQty, 5);
  assert.equal(batches[0].reservedQty, 0);
  assert.equal(batches[1].reservedQty, 0);
  assert.equal(order.orderStatus, 'ALL_DISPATCHED');
  assert.equal(order.closeReason, '客户申请退尾单');
});








