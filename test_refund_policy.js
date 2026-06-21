const assert = require('assert');
const {
  db,
  initDb,
  yuanToFen,
  fenToYuan,
  dateToStr,
  addDays,
  createOrder,
  cancelOrder,
  addPayment,
  collectDeposit,
  getHostMonthlyReport,
  exportHostMonthlyReportCSV,
} = require('./db');

const {
  REFUND_TIERS,
  REFUND_TIER_RATES,
  PLATFORM_FEE_RATE,
  determineRefundTier,
  calculateRefund,
  calculateRefundForLegacyOrder,
  calculatePlatformFee,
  calculateHostPayout,
  getRefundTierInfo,
  getAllRefundTiers,
} = require('./services/refund_policy');

let passed = 0;
let failed = 0;

initDb();

db.exec("PRAGMA foreign_keys = OFF");
db.exec("DELETE FROM payments; DELETE FROM room_dates; DELETE FROM cleanings; DELETE FROM guests; DELETE FROM orders; DELETE FROM rooms; DELETE FROM holidays;");
db.exec("DELETE FROM sqlite_sequence WHERE name IN ('payments', 'rooms', 'orders', 'room_dates', 'cleanings', 'holidays', 'guests')");
db.exec("PRAGMA foreign_keys = ON");

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
    failed++;
  }
}

console.log('\n=== 退款政策核心算法测试 ===\n');

test('REFUND_TIERS 常量定义完整', () => {
  assert.strictEqual(REFUND_TIERS.FULL, 'full');
  assert.strictEqual(REFUND_TIERS.SEVENTY, 'seventy');
  assert.strictEqual(REFUND_TIERS.THIRTY, 'thirty');
  assert.strictEqual(REFUND_TIERS.NONE, 'none');
});

test('REFUND_TIER_RATES 档位比例正确', () => {
  assert.strictEqual(REFUND_TIER_RATES[REFUND_TIERS.FULL], 100);
  assert.strictEqual(REFUND_TIER_RATES[REFUND_TIERS.SEVENTY], 70);
  assert.strictEqual(REFUND_TIER_RATES[REFUND_TIERS.THIRTY], 30);
  assert.strictEqual(REFUND_TIER_RATES[REFUND_TIERS.NONE], 0);
});

test('determineRefundTier: 提前10天 - 全额退款档位', () => {
  const tier = determineRefundTier('2024-07-15', '2024-07-05');
  assert.strictEqual(tier, REFUND_TIERS.FULL);
});

test('determineRefundTier: 提前7天整 - 全额退款档位', () => {
  const tier = determineRefundTier('2024-07-15', '2024-07-08');
  assert.strictEqual(tier, REFUND_TIERS.FULL);
});

test('determineRefundTier: 提前6天 - 70%档位', () => {
  const tier = determineRefundTier('2024-07-15', '2024-07-09');
  assert.strictEqual(tier, REFUND_TIERS.SEVENTY);
});

test('determineRefundTier: 提前3天整 - 70%档位', () => {
  const tier = determineRefundTier('2024-07-15', '2024-07-12');
  assert.strictEqual(tier, REFUND_TIERS.SEVENTY);
});

test('determineRefundTier: 提前2天 - 30%档位', () => {
  const tier = determineRefundTier('2024-07-15', '2024-07-13');
  assert.strictEqual(tier, REFUND_TIERS.THIRTY);
});

test('determineRefundTier: 提前1天整 - 30%档位', () => {
  const tier = determineRefundTier('2024-07-15', '2024-07-14');
  assert.strictEqual(tier, REFUND_TIERS.THIRTY);
});

test('determineRefundTier: 入住当天 - 不退档位', () => {
  const tier = determineRefundTier('2024-07-15', '2024-07-15');
  assert.strictEqual(tier, REFUND_TIERS.NONE);
});

test('determineRefundTier: 入住后 - 不退档位', () => {
  const tier = determineRefundTier('2024-07-15', '2024-07-16');
  assert.strictEqual(tier, REFUND_TIERS.NONE);
});

console.log('\n=== 退款金额计算测试（按分计算，无浮点误差）===\n');

test('calculateRefund: 1000元订单，提前10天 - 全额退款1000元', () => {
  const result = calculateRefund(yuanToFen(1000), '2024-07-15', '2024-07-05');
  assert.strictEqual(result.tier, REFUND_TIERS.FULL);
  assert.strictEqual(result.rate, 100);
  assert.strictEqual(result.total_price_cents, 100000);
  assert.strictEqual(result.refund_cents, 100000);
  assert.strictEqual(result.cancel_fee_cents, 0);
});

test('calculateRefund: 1000元订单，提前5天 - 退款700元', () => {
  const result = calculateRefund(yuanToFen(1000), '2024-07-15', '2024-07-10');
  assert.strictEqual(result.tier, REFUND_TIERS.SEVENTY);
  assert.strictEqual(result.rate, 70);
  assert.strictEqual(result.refund_cents, 70000);
  assert.strictEqual(result.cancel_fee_cents, 30000);
});

test('calculateRefund: 1000元订单，提前2天 - 退款300元', () => {
  const result = calculateRefund(yuanToFen(1000), '2024-07-15', '2024-07-13');
  assert.strictEqual(result.tier, REFUND_TIERS.THIRTY);
  assert.strictEqual(result.rate, 30);
  assert.strictEqual(result.refund_cents, 30000);
  assert.strictEqual(result.cancel_fee_cents, 70000);
});

test('calculateRefund: 1000元订单，入住当天 - 退款0元', () => {
  const result = calculateRefund(yuanToFen(1000), '2024-07-15', '2024-07-15');
  assert.strictEqual(result.tier, REFUND_TIERS.NONE);
  assert.strictEqual(result.rate, 0);
  assert.strictEqual(result.refund_cents, 0);
  assert.strictEqual(result.cancel_fee_cents, 100000);
});

test('calculateRefund: 金额按整数分计算，无浮点误差', () => {
  const result = calculateRefund(999, '2024-07-15', '2024-07-10');
  assert.strictEqual(result.refund_cents, Math.round(999 * 0.7));
  assert.strictEqual(Number.isInteger(result.refund_cents), true);
  assert.strictEqual(Number.isInteger(result.cancel_fee_cents), true);
});

test('calculateRefund: 负金额抛出错误', () => {
  let threw = false;
  try {
    calculateRefund(-100, '2024-07-15', '2024-07-10');
  } catch (e) {
    threw = true;
    assert.ok(e.message.includes('不能为负'));
  }
  assert.strictEqual(threw, true);
});

console.log('\n=== 老订单兼容测试 ===\n');

test('calculateRefundForLegacyOrder: 老订单全额退款', () => {
  const result = calculateRefundForLegacyOrder(yuanToFen(1000));
  assert.strictEqual(result.tier, REFUND_TIERS.FULL);
  assert.strictEqual(result.rate, 100);
  assert.strictEqual(result.refund_cents, 100000);
  assert.strictEqual(result.cancel_fee_cents, 0);
  assert.strictEqual(result.is_legacy, true);
});

test('getRefundTierInfo: 获取档位信息', () => {
  const info = getRefundTierInfo(REFUND_TIERS.SEVENTY);
  assert.strictEqual(info.tier, REFUND_TIERS.SEVENTY);
  assert.strictEqual(info.rate, 70);
  assert.ok(info.description.includes('70%'));
});

test('getAllRefundTiers: 获取所有档位', () => {
  const tiers = getAllRefundTiers();
  assert.strictEqual(tiers.length, 4);
  assert.ok(tiers.some(t => t.tier === REFUND_TIERS.FULL));
  assert.ok(tiers.some(t => t.tier === REFUND_TIERS.SEVENTY));
  assert.ok(tiers.some(t => t.tier === REFUND_TIERS.THIRTY));
  assert.ok(tiers.some(t => t.tier === REFUND_TIERS.NONE));
});

console.log('\n=== 平台抽成与房东实得计算测试 ===\n');

test('PLATFORM_FEE_RATE 为 10%', () => {
  assert.strictEqual(PLATFORM_FEE_RATE, 10);
});

test('calculatePlatformFee: 1000元抽成100元', () => {
  const fee = calculatePlatformFee(yuanToFen(1000));
  assert.strictEqual(fee, 10000);
});

test('calculatePlatformFee: 999元抽成100元（四舍五入）', () => {
  const fee = calculatePlatformFee(999);
  assert.strictEqual(fee, 100);
});

test('calculateHostPayout: 1000元订单无退款，房东得900元', () => {
  const result = calculateHostPayout(yuanToFen(1000), 0);
  assert.strictEqual(result.total_price_cents, 100000);
  assert.strictEqual(result.refund_cents, 0);
  assert.strictEqual(result.effective_total_cents, 100000);
  assert.strictEqual(result.platform_fee_cents, 10000);
  assert.strictEqual(result.host_payout_cents, 90000);
});

test('calculateHostPayout: 1000元订单退款300元，房东得630元', () => {
  const result = calculateHostPayout(yuanToFen(1000), yuanToFen(300));
  assert.strictEqual(result.total_price_cents, 100000);
  assert.strictEqual(result.refund_cents, 30000);
  assert.strictEqual(result.effective_total_cents, 70000);
  assert.strictEqual(result.platform_fee_cents, 7000);
  assert.strictEqual(result.host_payout_cents, 63000);
});

test('calculateHostPayout: 1000元订单全额退款，房东得0元', () => {
  const result = calculateHostPayout(yuanToFen(1000), yuanToFen(1000));
  assert.strictEqual(result.effective_total_cents, 0);
  assert.strictEqual(result.platform_fee_cents, 0);
  assert.strictEqual(result.host_payout_cents, 0);
});

test('calculateHostPayout: 退款超过订单金额时，按0计算', () => {
  const result = calculateHostPayout(yuanToFen(1000), yuanToFen(1500));
  assert.strictEqual(result.effective_total_cents, 0);
  assert.strictEqual(result.platform_fee_cents, 0);
  assert.strictEqual(result.host_payout_cents, 0);
});

console.log('\n=== 数据库集成测试：取消订单 ===\n');

const roomResult = db.prepare(`
  INSERT INTO rooms (name, capacity, bedrooms, weekday_price, weekend_price, holiday_price, deposit_amount_cents)
  VALUES ('测试退款房', 2, 1, 200, 300, 500, 100000)
`).run();
const roomId = roomResult.lastInsertRowid;

const today = new Date();
const formatDate = (d) => {
  let date;
  if (d instanceof Date) {
    date = d;
  } else if (typeof d === 'string') {
    date = new Date(d);
  } else {
    throw new Error('formatDate requires Date or string');
  }
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

test('createOrder: 创建未来订单用于测试', () => {
  const futureDate = addMonths(today, 1);
  const checkIn = formatDate(futureDate);
  const checkOut = formatDate(addDays(futureDate, 3));
  const orderId = createOrder(roomId, '测试客', '13800138000', checkIn, checkOut, '张阿姨');
  assert.ok(orderId > 0);

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  assert.strictEqual(order.status, 'confirmed');
  assert.strictEqual(order.refund_processed, 0);
});

test('cancelOrder: 提前30天取消，全额退款，记录档位', () => {
  const futureDate = addMonths(today, 2);
  const checkIn = formatDate(futureDate);
  const checkOut = formatDate(addDays(futureDate, 3));
  const orderId = createOrder(roomId, '全额退客', '13900139000', checkIn, checkOut, '李阿姨');
  
  const order = db.prepare('SELECT total_price FROM orders WHERE id = ?').get(orderId);
  const totalPriceCents = yuanToFen(Number(order.total_price));

  addPayment(orderId, totalPriceCents, 'room_fee', 'wechat', '全款');
  collectDeposit(orderId, yuanToFen(1000), 'wechat', '押金');

  const result = cancelOrder(orderId);
  assert.strictEqual(result.tier, REFUND_TIERS.FULL);
  assert.strictEqual(result.room_fee_refund_cents, totalPriceCents);
  assert.strictEqual(result.deposit_refund_cents, 100000);
  assert.strictEqual(result.platform_fee_cents, 0);
  assert.strictEqual(result.host_payout_cents, 0);

  const updatedOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  assert.strictEqual(updatedOrder.status, 'cancelled');
  assert.strictEqual(updatedOrder.refund_tier, REFUND_TIERS.FULL);
  assert.strictEqual(Number(updatedOrder.refund_cents), totalPriceCents);
  assert.strictEqual(Number(updatedOrder.refund_processed), 1);
});

test('cancelOrder: 防重复退款保护', () => {
  const futureDate = addMonths(today, 2);
  const checkIn = formatDate(futureDate);
  const checkOut = formatDate(addDays(futureDate, 3));
  const orderId = createOrder(roomId, '重复退款客', '13700137000', checkIn, checkOut, '王阿姨');

  cancelOrder(orderId);

  let threw = false;
  try {
    cancelOrder(orderId);
  } catch (e) {
    threw = true;
    assert.ok(e.message.includes('已取消') || e.message.includes('重复') || e.message.includes('已处理'));
  }
  assert.strictEqual(threw, true);
});

test('cancelOrder: 退款记录写入 payments 表', () => {
  const futureDate = addMonths(today, 2);
  const checkIn = formatDate(futureDate);
  const checkOut = formatDate(addDays(futureDate, 3));
  const orderId = createOrder(roomId, '流水测试客', '13600136000', checkIn, checkOut, '张阿姨');

  const order = db.prepare('SELECT total_price FROM orders WHERE id = ?').get(orderId);
  const totalPriceCents = yuanToFen(Number(order.total_price));

  addPayment(orderId, totalPriceCents, 'room_fee', 'wechat', '全款');
  collectDeposit(orderId, yuanToFen(1000), 'wechat', '押金');

  cancelOrder(orderId);

  const payments = db.prepare(`
    SELECT * FROM payments WHERE order_id = ? ORDER BY id
  `).all(orderId);

  const refundRows = payments.filter(p => p.type === 'room_fee_refund');
  assert.strictEqual(refundRows.length, 1);
  assert.strictEqual(Number(refundRows[0].amount_cents), totalPriceCents);

  const depositRefundRows = payments.filter(p => p.type === 'deposit_refund');
  assert.ok(depositRefundRows.length >= 1);
});

console.log('\n=== 房东月度对账报表测试 ===\n');

db.exec("DELETE FROM payments; DELETE FROM room_dates; DELETE FROM cleanings; DELETE FROM guests; DELETE FROM orders;");
db.exec("DELETE FROM sqlite_sequence WHERE name IN ('payments', 'orders', 'room_dates', 'cleanings', 'guests')");

const now = new Date();
const futureMonth = addMonths(now, 2);
const curY = futureMonth.getFullYear();
const curM = futureMonth.getMonth() + 1;
const monthPrefix = `${curY}-${String(curM).padStart(2, '0')}`;

const reportRoomId = db.prepare(`
  INSERT INTO rooms (name, capacity, bedrooms, weekday_price, weekend_price, holiday_price, deposit_amount_cents)
  VALUES ('对账测试房', 2, 1, 200, 300, 500, 100000)
`).run().lastInsertRowid;

const order1Id = createOrder(reportRoomId, '对账客1', '', `${monthPrefix}-05`, `${monthPrefix}-07`, '张阿姨');
const order1 = db.prepare('SELECT total_price FROM orders WHERE id = ?').get(order1Id);
addPayment(order1Id, yuanToFen(Number(order1.total_price)), 'room_fee', 'wechat', '房费');

const order2Id = createOrder(reportRoomId, '对账客2', '', `${monthPrefix}-10`, `${monthPrefix}-12`, '李阿姨');
const order2 = db.prepare('SELECT total_price FROM orders WHERE id = ?').get(order2Id);
addPayment(order2Id, yuanToFen(Number(order2.total_price)), 'room_fee', 'wechat', '房费');
cancelOrder(order2Id);

test('getHostMonthlyReport: 统计正确', () => {
  const report = getHostMonthlyReport(curY, curM);
  assert.strictEqual(report.year, curY);
  assert.strictEqual(report.month, curM);
  assert.strictEqual(report.platform_fee_rate, 10);

  assert.strictEqual(report.total.order_count, 2);
  assert.strictEqual(report.total.cancelled_count, 1);

  const room = report.rooms.find(r => r.room_id === reportRoomId);
  assert.ok(room);
  assert.strictEqual(room.order_count, 2);
  assert.strictEqual(room.cancelled_count, 1);

  const cancelledOrder = report.orders.find(o => o.order_id === order2Id);
  assert.ok(cancelledOrder);
  assert.strictEqual(cancelledOrder.status, 'cancelled');
  assert.ok(cancelledOrder.refund_amount_cents > 0);
  assert.ok(cancelledOrder.platform_fee_yuan >= 0);
  assert.ok(cancelledOrder.host_payout_yuan >= 0);
});

test('getHostMonthlyReport: 未取消订单按全额计算平台抽成', () => {
  const report = getHostMonthlyReport(curY, curM);
  const normalOrder = report.orders.find(o => o.order_id === order1Id);
  assert.ok(normalOrder);
  assert.strictEqual(normalOrder.status, 'confirmed');
  
  const expectedTotalCents = yuanToFen(Number(order1.total_price));
  const expectedPlatformFee = Math.round(expectedTotalCents * 0.1);
  const expectedHostPayout = expectedTotalCents - expectedPlatformFee;
  
  assert.strictEqual(normalOrder.total_price_cents, expectedTotalCents);
  assert.strictEqual(normalOrder.platform_fee_cents, expectedPlatformFee);
  assert.strictEqual(normalOrder.host_payout_cents, expectedHostPayout);
});

test('exportHostMonthlyReportCSV: 生成CSV非空', () => {
  const csv = exportHostMonthlyReportCSV(curY, curM);
  assert.ok(csv.length > 100);
  assert.ok(csv.includes('房东月度对账报表'));
  assert.ok(csv.includes('对账测试房'));
  assert.ok(csv.includes('订单明细'));
  assert.ok(csv.includes('合计'));
});

test('exportHostMonthlyReportCSV: 包含退款档位和平台抽成', () => {
  const csv = exportHostMonthlyReportCSV(curY, curM);
  assert.ok(csv.includes('退款档位'));
  assert.ok(csv.includes('平台抽成(元)'));
  assert.ok(csv.includes('房东实得(元)'));
});

console.log('\n=== 老订单数据兼容测试（无refund_tier字段）===\n');

db.exec("DELETE FROM payments; DELETE FROM room_dates; DELETE FROM cleanings; DELETE FROM guests; DELETE FROM orders;");
db.exec("DELETE FROM sqlite_sequence WHERE name IN ('payments', 'orders', 'room_dates', 'cleanings', 'guests')");

test('老订单取消时自动按新规则计算', () => {
  const futureDate = addMonths(today, 2);
  const checkIn = formatDate(futureDate);
  const checkOut = formatDate(addDays(futureDate, 3));
  const orderId = createOrder(reportRoomId, '老订单客', '', checkIn, checkOut, '张阿姨');

  const orderBefore = db.prepare('SELECT total_price FROM orders WHERE id = ?').get(orderId);
  const totalPriceCents = yuanToFen(Number(orderBefore.total_price));

  addPayment(orderId, totalPriceCents, 'room_fee', 'wechat', '全款');

  db.prepare('UPDATE orders SET refund_tier = NULL WHERE id = ?').run(orderId);

  const result = cancelOrder(orderId);
  assert.strictEqual(result.tier, REFUND_TIERS.FULL);
  assert.strictEqual(result.room_fee_refund_cents, totalPriceCents);

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  assert.strictEqual(order.refund_tier, REFUND_TIERS.FULL);
});

console.log('\n========================================');
console.log(`测试完成：通过 ${passed} 个，失败 ${failed} 个`);
console.log('========================================\n');

if (failed > 0) {
  process.exit(1);
}
