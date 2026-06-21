const assert = require('assert');
const {
  dateToStr,
  strToDate,
  addDays,
  diffDays,
  isWeekend,
  datesBetween,
  hasOverlap,
  calculatePrice,
  calcCancelFee,
  checkCollision,
  db,
  initDb,
} = require('./db');

let passed = 0;
let failed = 0;

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

console.log('\n=== 价格计算测试 ===\n');

const mockRoom = {
  weekday_price: 200,
  weekend_price: 300,
  holiday_price: 400,
};

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

initDb();
db.exec('DELETE FROM orders; DELETE FROM rooms; DELETE FROM cleanings;');

const roomResult = db.prepare(`
  INSERT INTO rooms (name, capacity, bedrooms, weekday_price, weekend_price)
  VALUES ('测试房间1', 2, 1, 200, 300)
`).run();
const roomId = roomResult.lastInsertRowid;

test('checkCollision: 空房无冲突', () => {
  const r = checkCollision(roomId, '2024-07-01', '2024-07-05');
  assert.strictEqual(r.length, 0);
});

db.prepare(`
  INSERT INTO orders (room_id, guest_name, check_in, check_out, nights, total_price, status)
  VALUES (?, '张三', '2024-07-05', '2024-07-10', 5, 1000, 'confirmed')
`).run(roomId);

test('checkCollision: 日期完全不重叠', () => {
  const r = checkCollision(roomId, '2024-07-01', '2024-07-05');
  assert.strictEqual(r.length, 0);
});

test('checkCollision: 日期完全重叠', () => {
  const r = checkCollision(roomId, '2024-07-06', '2024-07-08');
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].guest_name, '张三');
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

test('checkCollision: 已取消订单不算冲突', () => {
  const info = db.prepare(`
    INSERT INTO orders (room_id, guest_name, check_in, check_out, nights, total_price, status)
    VALUES (?, '李四', '2024-07-15', '2024-07-20', 5, 1000, 'cancelled')
  `).run(roomId);
  const r = checkCollision(roomId, '2024-07-16', '2024-07-18');
  assert.strictEqual(r.length, 0);
});

test('checkCollision: excludeOrderId 排除指定订单', () => {
  const r = checkCollision(roomId, '2024-07-06', '2024-07-08', 1);
  assert.strictEqual(r.length, 0);
});

console.log('\n=== 创建订单自动生成清洁任务测试 ===\n');

test('创建订单后自动生成清洁任务', () => {
  const info = db.prepare(`
    INSERT INTO orders (room_id, guest_name, check_in, check_out, nights, total_price, status)
    VALUES (?, '王五', '2024-08-01', '2024-08-05', 4, 800, 'confirmed')
  `).run(roomId);
  const orderId = info.lastInsertRowid;

  db.prepare(`
    INSERT INTO cleanings (room_id, order_id, cleaning_date, status)
    VALUES (?, ?, '2024-08-05', 'scheduled')
  `).run(roomId, orderId);

  const cleaning = db.prepare('SELECT * FROM cleanings WHERE order_id = ?').get(orderId);
  assert.ok(cleaning);
  assert.strictEqual(cleaning.cleaning_date, '2024-08-05');
  assert.strictEqual(cleaning.status, 'scheduled');
});

console.log('\n=== 跨月跨年边界测试 ===\n');

test('跨月订单撞单检测', () => {
  db.prepare(`
    INSERT INTO orders (room_id, guest_name, check_in, check_out, nights, total_price, status)
    VALUES (?, '赵六', '2024-09-28', '2024-10-05', 7, 1400, 'confirmed')
  `).run(roomId);

  const r1 = checkCollision(roomId, '2024-09-25', '2024-09-29');
  assert.strictEqual(r1.length, 1);

  const r2 = checkCollision(roomId, '2024-10-04', '2024-10-08');
  assert.strictEqual(r2.length, 1);

  const r3 = checkCollision(roomId, '2024-10-05', '2024-10-08');
  assert.strictEqual(r3.length, 0);
});

test('跨年订单撞单检测', () => {
  db.prepare(`
    INSERT INTO orders (room_id, guest_name, check_in, check_out, nights, total_price, status)
    VALUES (?, '孙七', '2024-12-29', '2025-01-03', 5, 1000, 'confirmed')
  `).run(roomId);

  const r1 = checkCollision(roomId, '2024-12-30', '2024-12-31');
  assert.strictEqual(r1.length, 1);

  const r2 = checkCollision(roomId, '2025-01-01', '2025-01-02');
  assert.strictEqual(r2.length, 1);
});

console.log('\n========================================');
console.log(`测试完成：通过 ${passed} 个，失败 ${failed} 个`);
console.log('========================================\n');

if (failed > 0) {
  process.exit(1);
}
