const { db, initDb, createOrder, cancelOrder } = require('./db');

initDb();

db.exec('DELETE FROM room_dates; DELETE FROM cleanings; DELETE FROM orders; DELETE FROM rooms; DELETE FROM holidays;');

const room = db.prepare(`
  INSERT INTO rooms (name, capacity, bedrooms, weekday_price, weekend_price, holiday_price)
  VALUES ('测试房', 2, 1, 200, 300, 500)
`).run();
const roomId = room.lastInsertRowid;
console.log('roomId:', roomId);

try {
  const orderId = createOrder(roomId, '张三', '138', '2024-07-05', '2024-07-10', '张阿姨');
  console.log('orderId:', orderId);

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  console.log('order:', order);

  const dates = db.prepare('SELECT * FROM room_dates WHERE order_id = ?').all(orderId);
  console.log('room_dates count:', dates.length);
  console.log('room_dates:', dates);

  const cleanings = db.prepare('SELECT * FROM cleanings WHERE order_id = ?').all(orderId);
  console.log('cleanings count:', cleanings.length);
  console.log('cleanings:', cleanings);

  console.log('\n--- 测试取消 ---');
  const result = cancelOrder(orderId);
  console.log('cancel result:', result);

  const dates2 = db.prepare('SELECT * FROM room_dates WHERE order_id = ?').all(orderId);
  console.log('cancel后 room_dates count:', dates2.length);

  const cleaning2 = db.prepare('SELECT * FROM cleanings WHERE order_id = ?').get(orderId);
  console.log('cancel后 cleaning status:', cleaning2.status);

} catch (e) {
  console.error('ERROR:', e.message);
  console.error(e.stack);
}
