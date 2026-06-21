const assert = require('assert');
const {
  dateToStr,
  strToDate,
  addDays,
  diffDays,
  isWeekend,
  isHoliday,
  addHoliday,
  removeHoliday,
  datesBetween,
  hasOverlap,
  calculatePrice,
  calcCancelFee,
  checkCollision,
  checkCleanerConflict,
  createOrder,
  cancelOrder,
  db,
  initDb,
  yuanToFen,
  fenToYuan,
  addPayment,
  getPayments,
  getOrderFinance,
  collectDeposit,
  refundDeposit,
  getMonthlyFinanceReport,
  exportMonthlyFinanceCSV,
} = require('./db');

let passed = 0;
let failed = 0;

initDb();

db.exec("PRAGMA foreign_keys = OFF");
db.exec("DELETE FROM payments; DELETE FROM room_dates; DELETE FROM cleanings; DELETE FROM orders; DELETE FROM rooms; DELETE FROM holidays;");
db.exec("DELETE FROM sqlite_sequence WHERE name IN ('payments', 'rooms', 'orders', 'room_dates', 'cleanings', 'holidays')");
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

console.log('\n=== 日期工具函数测试 ===\n');

test('dateToStr 格式化日期', () => {
  const d = new Date(2024, 0, 15);
  assert.strictEqual(dateToStr(d), '2024-01-15');
});

test('strToDate 解析日期', () => {
  const d = strToDate('2024-06-15');
  assert.strictEqual(d.getFullYear(), 2024);
  assert.strictEqual(d.getMonth(), 5);
  assert.strictEqual(d.getDate(), 15);
});

test('addDays 日期加法', () => {
  assert.strictEqual(addDays('2024-01-15', 3), '2024-01-18');
});

test('addDays 跨月', () => {
  assert.strictEqual(addDays('2024-01-31', 1), '2024-02-01');
});

test('addDays 跨年', () => {
  assert.strictEqual(addDays('2024-12-31', 2), '2025-01-02');
});

test('addDays 闰年 2月', () => {
  assert.strictEqual(addDays('2024-02-28', 1), '2024-02-29');
  assert.strictEqual(addDays('2024-02-29', 1), '2024-03-01');
});

test('diffDays 计算天数差', () => {
  assert.strictEqual(diffDays('2024-01-15', '2024-01-20'), 5);
});

test('diffDays 跨月', () => {
  assert.strictEqual(diffDays('2024-01-30', '2024-02-03'), 4);
});

test('isWeekend 判断周末', () => {
  assert.strictEqual(isWeekend('2024-06-15'), true);
  assert.strictEqual(isWeekend('2024-06-16'), true);
  assert.strictEqual(isWeekend('2024-06-17'), false);
});

test('datesBetween 生成日期列表（不含退房日）', () => {
  const dates = datesBetween('2024-01-15', '2024-01-18');
  assert.deepStrictEqual(dates, ['2024-01-15', '2024-01-16', '2024-01-17']);
  assert.strictEqual(dates.length, 3);
});

console.log('\n=== 撞单检测核心测试 ===\n');

test('hasOverlap: 完全不重叠 - 新订单在前面', () => {
  assert.strictEqual(hasOverlap('2024-06-10', '2024-06-15', '2024-06-01', '2024-06-10'), false);
});

test('hasOverlap: 完全不重叠 - 新订单在后面', () => {
  assert.strictEqual(hasOverlap('2024-06-10', '2024-06-15', '2024-06-15', '2024-06-20'), false);
});

test('hasOverlap: 完全包含', () => {
  assert.strictEqual(hasOverlap('2024-06-10', '2024-06-20', '2024-06-12', '2024-06-18'), true);
});

test('hasOverlap: 左端重叠', () => {
  assert.strictEqual(hasOverlap('2024-06-10', '2024-06-15', '2024-06-08', '2024-06-12'), true);
});

test('hasOverlap: 右端重叠', () => {
  assert.strictEqual(hasOverlap('2024-06-10', '2024-06-15', '2024-06-13', '2024-06-18'), true);
});

test('hasOverlap: 当天退房当天入住 - 不撞（可以衔接）', () => {
  assert.strictEqual(hasOverlap('2024-06-10', '2024-06-15', '2024-06-15', '2024-06-20'), false);
});

test('hasOverlap: 完全相同日期 - 撞', () => {
  assert.strictEqual(hasOverlap('2024-06-10', '2024-06-15', '2024-06-10', '2024-06-15'), true);
});

console.log('\n=== 节假日价格测试 ===\n');

const mockRoom = {
  weekday_price: 200,
  weekend_price: 300,
  holiday_price: 500,
};

test('isHoliday: 默认不是节假日', () => {
  assert.strictEqual(isHoliday('2024-10-01'), false);
});

test('addHoliday: 添加节假日', () => {
  const ok = addHoliday('2024-10-01', '国庆节');
  assert.strictEqual(ok, true);
  assert.strictEqual(isHoliday('2024-10-01'), true);
});

test('addHoliday: 重复添加返回 false', () => {
  const ok = addHoliday('2024-10-01', '国庆节');
  assert.strictEqual(ok, false);
});

test('calculatePrice: 节假日价格生效', () => {
  addHoliday('2024-10-01', '国庆');
  addHoliday('2024-10-02', '国庆');
  const r = calculatePrice(mockRoom, '2024-09-30', '2024-10-03');
  assert.strictEqual(r.nights, 3);
  assert.strictEqual(r.total, 200 + 500 + 500);
});

test('removeHoliday: 移除节假日', () => {
  addHoliday('2024-12-25', '圣诞');
  assert.strictEqual(isHoliday('2024-12-25'), true);
  const ok = removeHoliday('2024-12-25');
  assert.strictEqual(ok, true);
  assert.strictEqual(isHoliday('2024-12-25'), false);
});

console.log('\n=== 价格计算测试 ===\n');

test('calculatePrice: 工作日 3 晚', () => {
  const r = calculatePrice(mockRoom, '2024-06-17', '2024-06-20');
  assert.strictEqual(r.nights, 3);
  assert.strictEqual(r.total, 600);
});

test('calculatePrice: 周末 2 晚（周六周日）', () => {
  const r = calculatePrice(mockRoom, '2024-06-15', '2024-06-17');
  assert.strictEqual(r.nights, 2);
  assert.strictEqual(r.total, 600);
});

test('calculatePrice: 跨周末 5 晚', () => {
  const r = calculatePrice(mockRoom, '2024-06-13', '2024-06-18');
  assert.strictEqual(r.nights, 5);
  assert.strictEqual(r.total, 200 * 3 + 300 * 2);
});

console.log('\n=== 退订规则测试 ===\n');

test('calcCancelFee: 提前 10 天 - 全额退款', () => {
  const r = calcCancelFee(mockRoom, '2024-07-01', '2024-07-05', '2024-06-20');
  assert.strictEqual(r.fee, 0);
  assert.strictEqual(r.refund, 800);
});

test('calcCancelFee: 提前 5 天 - 扣 50%', () => {
  const r = calcCancelFee(mockRoom, '2024-07-01', '2024-07-05', '2024-06-26');
  assert.strictEqual(r.fee, 400);
  assert.strictEqual(r.refund, 400);
});

test('calcCancelFee: 提前 2 天 - 扣 80%', () => {
  const r = calcCancelFee(mockRoom, '2024-07-01', '2024-07-05', '2024-06-29');
  assert.strictEqual(r.fee, 640);
  assert.strictEqual(r.refund, 160);
});

test('calcCancelFee: 当天取消 - 不退', () => {
  const r = calcCancelFee(mockRoom, '2024-07-01', '2024-07-05', '2024-07-01');
  assert.strictEqual(r.fee, 800);
  assert.strictEqual(r.refund, 0);
});

console.log('\n=== 数据库集成测试 ===\n');

db.exec('DELETE FROM payments; DELETE FROM room_dates; DELETE FROM cleanings; DELETE FROM orders; DELETE FROM rooms; DELETE FROM holidays;');
db.exec("DELETE FROM sqlite_sequence WHERE name IN ('payments', 'rooms', 'orders', 'room_dates', 'cleanings', 'holidays')");

const roomResult = db.prepare(`
  INSERT INTO rooms (name, capacity, bedrooms, weekday_price, weekend_price, holiday_price)
  VALUES ('测试房间1', 2, 1, 200, 300, 500)
`).run();
const roomId = roomResult.lastInsertRowid;

let order1Id;

test('checkCollision: 空房无冲突', () => {
  const r = checkCollision(roomId, '2024-07-01', '2024-07-05');
  assert.strictEqual(r.length, 0);
});

test('createOrder: 正常下单', () => {
  order1Id = createOrder(roomId, '张三', '13800138000', '2024-07-05', '2024-07-10', '张阿姨');
  assert.ok(order1Id > 0);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(order1Id);
  assert.strictEqual(order.guest_name, '张三');
  assert.strictEqual(order.nights, 5);
  assert.strictEqual(order.status, 'confirmed');
});

test('createOrder: room_dates 表有对应记录（双保险）', () => {
  const dates = db.prepare('SELECT date FROM room_dates WHERE order_id = ? ORDER BY date').all(order1Id);
  assert.strictEqual(dates.length, 5);
  assert.strictEqual(dates[0].date, '2024-07-05');
  assert.strictEqual(dates[4].date, '2024-07-09');
});

test('createOrder: 自动生成清洁任务', () => {
  const cleaning = db.prepare('SELECT * FROM cleanings WHERE order_id = ?').get(order1Id);
  assert.ok(cleaning);
  assert.strictEqual(cleaning.cleaning_date, '2024-07-10');
  assert.strictEqual(cleaning.cleaner_name, '张阿姨');
  assert.strictEqual(cleaning.status, 'scheduled');
});

test('checkCollision: 日期完全重叠', () => {
  const r = checkCollision(roomId, '2024-07-06', '2024-07-08');
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].guest_name, '张三');
});

test('checkCollision: 日期完全不重叠', () => {
  const r = checkCollision(roomId, '2024-07-01', '2024-07-05');
  assert.strictEqual(r.length, 0);
});

test('checkCollision: 左端重叠', () => {
  const r = checkCollision(roomId, '2024-07-03', '2024-07-07');
  assert.strictEqual(r.length, 1);
});

test('checkCollision: 右端重叠', () => {
  const r = checkCollision(roomId, '2024-07-08', '2024-07-12');
  assert.strictEqual(r.length, 1);
});

test('checkCollision: 包含关系', () => {
  const r = checkCollision(roomId, '2024-07-01', '2024-07-15');
  assert.strictEqual(r.length, 1);
});

test('createOrder: 撞单时 room_dates 唯一索引兜底（第二道保险）', () => {
  let threw = false;
  try {
    createOrder(roomId, '李四', '13900139000', '2024-07-07', '2024-07-12');
  } catch (e) {
    threw = true;
    assert.ok(e.message.includes('UNIQUE') || e.message.includes('唯一') || e.message.includes('room_dates'));
  }
  assert.strictEqual(threw, true, '撞单应该抛出错误');
});

test('checkCleanerConflict: 清洁阿姨冲突检测', () => {
  const conflicts = checkCleanerConflict('张阿姨', '2024-07-10');
  assert.strictEqual(conflicts.length, 1);
});

const room2Result = db.prepare(`
  INSERT INTO rooms (name, capacity, bedrooms, weekday_price, weekend_price, holiday_price)
  VALUES ('测试房间2', 3, 2, 300, 400, 600)
`).run();
const room2Id = room2Result.lastInsertRowid;

test('createOrder: 清洁阿姨冲突时不能下单（不同房间同一天退房，同一阿姨）', () => {
  let threw = false;
  try {
    createOrder(room2Id, '王五', '13700137000', '2024-07-07', '2024-07-10', '张阿姨');
  } catch (e) {
    threw = true;
    assert.ok(e.message.includes('清洁阿姨'));
  }
  assert.strictEqual(threw, true, '阿姨冲突应该抛出错误');
});

let order2Id;

test('createOrder: 换个阿姨可以下单', () => {
  order2Id = createOrder(roomId, '王五', '13700137000', '2024-07-12', '2024-07-15', '李阿姨');
  assert.ok(order2Id > 0);
});

test('createOrder: 取消订单后日期释放', () => {
  const result = cancelOrder(order2Id);
  assert.strictEqual(result.fee > 0, true);
  const dates = db.prepare('SELECT * FROM room_dates WHERE order_id = ?').all(order2Id);
  assert.strictEqual(dates.length, 0);
  const cleaning = db.prepare('SELECT * FROM cleanings WHERE order_id = ?').get(order2Id);
  assert.strictEqual(cleaning.status, 'cancelled');
});

test('checkCollision: 已取消订单不算冲突', () => {
  const r = checkCollision(roomId, '2024-07-12', '2024-07-15');
  assert.strictEqual(r.length, 0);
});

test('createOrder: 取消后可以重新下单同日期', () => {
  const orderId = createOrder(roomId, '赵六', '13600136000', '2024-07-12', '2024-07-15', '王阿姨');
  assert.ok(orderId > 0);
});

console.log('\n=== 跨月跨年边界测试 ===\n');

test('跨月订单撞单检测', () => {
  createOrder(roomId, '跨月客', '', '2024-09-28', '2024-10-05', '张阿姨');
  const r1 = checkCollision(roomId, '2024-09-25', '2024-09-29');
  assert.strictEqual(r1.length >= 1, true);

  const r2 = checkCollision(roomId, '2024-10-04', '2024-10-08');
  assert.strictEqual(r2.length >= 1, true);

  const r3 = checkCollision(roomId, '2024-10-05', '2024-10-08');
  assert.strictEqual(r3.length, 0);
});

test('跨年订单撞单检测', () => {
  createOrder(roomId, '跨年客', '', '2024-12-29', '2025-01-03', '李阿姨');
  const r1 = checkCollision(roomId, '2024-12-30', '2024-12-31');
  assert.strictEqual(r1.length >= 1, true);

  const r2 = checkCollision(roomId, '2025-01-01', '2025-01-02');
  assert.strictEqual(r2.length >= 1, true);
});

console.log('\n=== 节假日价格（数据库版）测试 ===\n');

test('节假日价格在 createOrder 中正确计算', () => {
  addHoliday('2025-05-01', '劳动节');
  addHoliday('2025-05-02', '劳动节');
  addHoliday('2025-05-03', '劳动节');

  const orderId = createOrder(roomId, '假期客', '', '2025-04-30', '2025-05-04', '张阿姨');
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);

  assert.strictEqual(order.nights, 4);
  const expected = 200 + 500 + 500 + 500;
  assert.strictEqual(order.total_price, expected);
});

console.log('\n========================================');
console.log(`测试完成：通过 ${passed} 个，失败 ${failed} 个`);
console.log('========================================\n');

if (failed > 0) {
  process.exit(1);
}

console.log('\n=== 财务：分元转换测试 ===\n');

test('yuanToFen: 整数元转分', () => {
  assert.strictEqual(yuanToFen(100), 10000);
  assert.strictEqual(yuanToFen(0), 0);
});

test('yuanToFen: 两位小数精确转分', () => {
  assert.strictEqual(yuanToFen(19.99), 1999);
  assert.strictEqual(yuanToFen(0.01), 1);
  assert.strictEqual(yuanToFen(2000.50), 200050);
});

test('yuanToFen: 浮点陷阱 0.1+0.2 四舍五入', () => {
  assert.strictEqual(yuanToFen(0.1 + 0.2), 30);
});

test('fenToYuan: 分转元', () => {
  assert.strictEqual(fenToYuan(10000), 100);
  assert.strictEqual(fenToYuan(1999), 19.99);
  assert.strictEqual(fenToYuan(1), 0.01);
  assert.strictEqual(fenToYuan(0), 0);
});

console.log('\n=== 财务：房源押金额度测试 ===\n');

const financeRoomResult = db.prepare(`
  INSERT INTO rooms (name, capacity, bedrooms, weekday_price, weekend_price, holiday_price, deposit_amount_cents)
  VALUES ('财务测试房-A', 2, 1, 200, 300, 500, 200000)
`).run();
const financeRoomId = financeRoomResult.lastInsertRowid;

test('房源押金额度：设置 2000 元 = 200000 分', () => {
  const r = db.prepare('SELECT deposit_amount_cents FROM rooms WHERE id = ?').get(financeRoomId);
  assert.strictEqual(Number(r.deposit_amount_cents), 200000);
});

test('下单时订单自动写入押金', () => {
  const oid = createOrder(financeRoomId, '财务客人1', '', '2025-06-10', '2025-06-12', '张阿姨');
  const o = db.prepare('SELECT deposit_amount_cents, total_price FROM orders WHERE id = ?').get(oid);
  assert.strictEqual(Number(o.deposit_amount_cents), 200000);
  assert.strictEqual(o.total_price, 400);
});

console.log('\n=== 财务：收款流水与押金收付测试 ===\n');

db.exec("DELETE FROM payments WHERE 1=1");
const finOrderId = createOrder(financeRoomId, '财务客人2', '', '2025-06-16', '2025-06-18', '李阿姨');

test('新订单：应收房费 400元（两个工作日） + 押金 2000元，欠款合计 2400元', () => {
  const f = getOrderFinance(finOrderId);
  assert.strictEqual(f.total_room_fee_cents, 40000);
  assert.strictEqual(f.deposit_receivable_cents, 200000);
  assert.strictEqual(f.total_receivable_cents, 240000);
  assert.strictEqual(f.total_owed_cents, 240000);
});

test('addPayment: 收 200 元房费定金（微信）', () => {
  const pid = addPayment(finOrderId, yuanToFen(200), 'room_fee', 'wechat', '定金');
  assert.ok(pid > 0);
  const f = getOrderFinance(finOrderId);
  assert.strictEqual(f.room_fee_received_cents, 20000);
  assert.strictEqual(f.room_fee_owed_cents, 20000);
});

test('addPayment: 收尾款 200 元（现金）', () => {
  addPayment(finOrderId, yuanToFen(200), 'room_fee', 'cash', '尾款');
  const f = getOrderFinance(finOrderId);
  assert.strictEqual(f.room_fee_received_cents, 40000);
  assert.strictEqual(f.room_fee_owed_cents, 0);
});

test('collectDeposit: 收押金 2000 元', () => {
  const pid = collectDeposit(finOrderId, yuanToFen(2000), 'wechat', '入住押金');
  assert.ok(pid > 0);
  const f = getOrderFinance(finOrderId);
  assert.strictEqual(f.deposit_received_cents, 200000);
  assert.strictEqual(f.deposit_net_cents, 200000);
  assert.strictEqual(f.total_owed_cents, 0);
});

test('getPayments: 流水记录共 3 条', () => {
  const list = getPayments(finOrderId);
  assert.strictEqual(list.length, 3);
  assert.strictEqual(list[0].type, 'room_fee');
  assert.strictEqual(list[2].type, 'deposit');
});

test('应收=已收+欠款：三者必须对得上', () => {
  const f = getOrderFinance(finOrderId);
  assert.strictEqual(f.total_room_fee_cents, f.room_fee_received_cents + f.room_fee_owed_cents);
  assert.strictEqual(f.deposit_receivable_cents, f.deposit_received_cents + f.deposit_owed_cents);
  assert.strictEqual(f.total_receivable_cents, f.total_received_cents + f.total_owed_cents);
});

console.log('\n=== 财务：退押金（含扣款）测试 ===\n');

test('refundDeposit: 扣 50 元清洁费，退 1950 元', () => {
  const r = refundDeposit(finOrderId, yuanToFen(1950), yuanToFen(50), '打扫卫生清洁费', 'wechat');
  assert.strictEqual(r.refund_cents, 195000);
  assert.strictEqual(r.deducted_cents, 5000);
  const f = getOrderFinance(finOrderId);
  assert.strictEqual(f.deposit_refunded_cents, 200000);
  assert.strictEqual(f.deposit_net_cents, 0);
});

test('退押金后流水共 5 条（2 条房费 + 1 条收押金 + 1 条扣款 + 1 条退款）', () => {
  const list = getPayments(finOrderId);
  assert.strictEqual(list.length, 5);
  const refundRows = list.filter(p => p.type === 'deposit_refund');
  assert.strictEqual(refundRows.length, 2);
  const totalOut = refundRows.reduce((s, p) => s + Number(p.amount_cents), 0);
  assert.strictEqual(totalOut, 200000);
});

test('refundDeposit: 余额不足时不能超额退款', () => {
  let threw = false;
  try {
    refundDeposit(finOrderId, 100, 0, '', 'wechat');
  } catch (e) {
    threw = true;
    assert.ok(e.message.includes('超过'));
  }
  assert.strictEqual(threw, true);
});

console.log('\n=== 财务：老订单兼容（无押金）测试 ===\n');

const noDepositRoomId = db.prepare(`
  INSERT INTO rooms (name, capacity, bedrooms, weekday_price, weekend_price, holiday_price, deposit_amount_cents)
  VALUES ('无押金房', 2, 1, 150, 200, 300, 0)
`).run().lastInsertRowid;

test('房源无押金时，订单押金为 0，不影响查询', () => {
  const oid = createOrder(noDepositRoomId, '老客', '', '2025-06-20', '2025-06-21', '王阿姨');
  const f = getOrderFinance(oid);
  assert.strictEqual(f.deposit_receivable_cents, 0);
  assert.strictEqual(f.total_room_fee_cents, 15000);
  assert.strictEqual(f.total_receivable_cents, 15000);
});

console.log('\n=== 财务：退订押金一起退测试 ===\n');

const cancelOrderId = createOrder(financeRoomId, '要取消的客人', '', '2025-08-01', '2025-08-03', '张阿姨');
collectDeposit(cancelOrderId, yuanToFen(2000), 'wechat', '押金');
addPayment(cancelOrderId, yuanToFen(400), 'room_fee', 'wechat', '全款');

test('cancelOrder: 退订时押金自动退还', () => {
  const r = cancelOrder(cancelOrderId);
  assert.ok(r.deposit_refund >= 2000);
  const f = getOrderFinance(cancelOrderId);
  assert.strictEqual(f.deposit_net_cents, 0);
});

test('cancelOrder 后 deposit_refund 流水存在', () => {
  const list = getPayments(cancelOrderId);
  const refundRows = list.filter(p => p.type === 'deposit_refund' && p.note && p.note.includes('退订'));
  assert.strictEqual(refundRows.length, 1);
  assert.strictEqual(Number(refundRows[0].amount_cents), 200000);
});

console.log('\n=== 财务：月度对账报表测试 ===\n');

db.exec("DELETE FROM payments WHERE 1=1");
db.exec("DELETE FROM room_dates; DELETE FROM cleanings; DELETE FROM orders;");

const repRoom1 = db.prepare(`
  INSERT INTO rooms (name, capacity, bedrooms, weekday_price, weekend_price, holiday_price, deposit_amount_cents)
  VALUES ('对账房A', 2, 1, 100, 150, 200, 100000)
`).run().lastInsertRowid;
const repRoom2 = db.prepare(`
  INSERT INTO rooms (name, capacity, bedrooms, weekday_price, weekend_price, holiday_price, deposit_amount_cents)
  VALUES ('对账房B', 2, 1, 200, 300, 400, 200000)
`).run().lastInsertRowid;

const repNow = new Date();
const repY = repNow.getFullYear();
const repM = repNow.getMonth() + 1;
const repPrefix = `${repY}-${String(repM).padStart(2, '0')}`;

const repO1 = createOrder(repRoom1, '月测客1', '', `${repPrefix}-10`, `${repPrefix}-12`, '张阿姨');
const repO1Total = Number(db.prepare('SELECT total_price FROM orders WHERE id=?').get(repO1).total_price);
const repO1RoomFeeCents = yuanToFen(repO1Total);
addPayment(repO1, yuanToFen(200), 'room_fee', 'wechat', '房费');
collectDeposit(repO1, yuanToFen(1000), 'wechat', '押金');

const repO2 = createOrder(repRoom2, '月测客2', '', `${repPrefix}-15`, `${repPrefix}-17`, '李阿姨');
addPayment(repO2, yuanToFen(200), 'room_fee', 'wechat', '定金');
collectDeposit(repO2, yuanToFen(2000), 'cash', '押金');
refundDeposit(repO2, yuanToFen(1900), yuanToFen(100), '扣清洁费', 'cash');

test('getMonthlyFinanceReport: 对账房A 数据正确', () => {
  const r = getMonthlyFinanceReport(repY, repM);
  const ra = r.rooms.find(x => x.room_id === repRoom1);
  assert.ok(ra);
  assert.strictEqual(ra.room_fee_receivable_cents, repO1RoomFeeCents);
  assert.strictEqual(ra.room_fee_received_cents, yuanToFen(200));
  assert.strictEqual(ra.room_fee_owed_cents, Math.max(0, repO1RoomFeeCents - yuanToFen(200)));
  assert.strictEqual(ra.deposit_receivable_cents, 100000);
  assert.strictEqual(ra.deposit_in_cents, 100000);
  assert.strictEqual(ra.deposit_out_cents, 0);
  assert.strictEqual(ra.deposit_net_cents, 100000);
});

test('getMonthlyFinanceReport: 对账房B 押金扣款后净额正确', () => {
  const r = getMonthlyFinanceReport(repY, repM);
  const rb = r.rooms.find(x => x.room_id === repRoom2);
  assert.ok(rb);
  assert.strictEqual(rb.deposit_in_cents, 200000);
  assert.strictEqual(rb.deposit_out_cents, 200000);
  assert.strictEqual(rb.deposit_net_cents, 0);
});

test('getMonthlyFinanceReport: 合计行汇总正确', () => {
  const r = getMonthlyFinanceReport(repY, repM);
  const t = r.total;
  const rooms = r.rooms;
  assert.strictEqual(t.room_fee_receivable_yuan,
    rooms.reduce((s, x) => s + x.room_fee_receivable_yuan, 0));
  assert.strictEqual(t.deposit_in_yuan,
    rooms.reduce((s, x) => s + x.deposit_in_yuan, 0));
});

test('exportMonthlyFinanceCSV: 生成 CSV 非空，含合计行', () => {
  const csv = exportMonthlyFinanceCSV(repY, repM);
  assert.ok(csv.length > 100);
  assert.ok(csv.includes('合计'));
  assert.ok(csv.includes('对账房A'));
  assert.ok(csv.includes('对账房B'));
});

test('exportMonthlyFinanceCSV: 字段用逗号分隔，含表头', () => {
  const csv = exportMonthlyFinanceCSV(repY, repM);
  assert.ok(csv.includes('房源'));
  assert.ok(csv.includes('房费应收(元)'));
  assert.ok(csv.includes('合计应收(元)'));
});

console.log('\n=== 财务：非法金额与参数校验 ===\n');

test('addPayment: 金额 <= 0 报错', () => {
  let threw = false;
  try { addPayment(repO1, 0, 'room_fee', 'wechat'); } catch (e) { threw = true; }
  assert.strictEqual(threw, true);
});

test('addPayment: 类型非法报错', () => {
  let threw = false;
  try { addPayment(repO1, 100, 'bad_type', 'wechat'); } catch (e) { threw = true; }
  assert.strictEqual(threw, true);
});

test('addPayment: 方式非法报错', () => {
  let threw = false;
  try { addPayment(repO1, 100, 'room_fee', 'alipay'); } catch (e) { threw = true; }
  assert.strictEqual(threw, true);
});

test('refundDeposit: 扣款或退款为负报错', () => {
  let threw = false;
  try { refundDeposit(repO1, 100, -50, '', 'wechat'); } catch (e) { threw = true; }
  assert.strictEqual(threw, true);
});

console.log('\n========================================');
console.log(`测试完成：通过 ${passed} 个，失败 ${failed} 个`);
console.log('========================================\n');

if (failed > 0) {
  process.exit(1);
}
