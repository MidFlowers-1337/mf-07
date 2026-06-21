const { Hono } = require('hono');
const { serve } = require('@hono/node-server');
const { serveStatic } = require('@hono/node-server/serve-static');
const path = require('path');
const {
  db,
  initDb,
  dateToStr,
  diffDays,
  calculatePrice,
  checkCollision,
  checkCleanerConflict,
  createOrder,
  cancelOrder,
  getHolidays,
  addHoliday,
  addHolidayRange,
  removeHoliday,
  removeHolidayByName,
  isHoliday,
} = require('./db');

initDb();

const app = new Hono();

app.get('/api/rooms', (c) => {
  const rooms = db.prepare('SELECT * FROM rooms ORDER BY id').all();
  return c.json(rooms);
});

app.get('/api/rooms/:id', (c) => {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(c.req.param('id'));
  if (!room) return c.json({ error: '房源不存在' }, 404);
  return c.json(room);
});

app.post('/api/rooms', async (c) => {
  const body = await c.req.json();
  const { name, capacity, bedrooms, facilities, check_in_time, check_out_time, weekday_price, weekend_price, holiday_price } = body;
  if (!name) return c.json({ error: '房源名称必填' }, 400);

  const info = db.prepare(`
    INSERT INTO rooms (name, capacity, bedrooms, facilities, check_in_time, check_out_time, weekday_price, weekend_price, holiday_price)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name,
    capacity || 2,
    bedrooms || 1,
    facilities || '',
    check_in_time || '14:00',
    check_out_time || '12:00',
    weekday_price || 200,
    weekend_price || 300,
    holiday_price || 400
  );
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(info.lastInsertRowid);
  return c.json(room);
});

app.put('/api/rooms/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const existing = db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);
  if (!existing) return c.json({ error: '房源不存在' }, 404);

  db.prepare(`
    UPDATE rooms SET
      name = ?, capacity = ?, bedrooms = ?, facilities = ?,
      check_in_time = ?, check_out_time = ?,
      weekday_price = ?, weekend_price = ?, holiday_price = ?
    WHERE id = ?
  `).run(
    body.name ?? existing.name,
    body.capacity ?? existing.capacity,
    body.bedrooms ?? existing.bedrooms,
    body.facilities ?? existing.facilities,
    body.check_in_time ?? existing.check_in_time,
    body.check_out_time ?? existing.check_out_time,
    body.weekday_price ?? existing.weekday_price,
    body.weekend_price ?? existing.weekend_price,
    body.holiday_price ?? existing.holiday_price,
    id
  );
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);
  return c.json(room);
});

app.delete('/api/rooms/:id', (c) => {
  const id = c.req.param('id');
  const hasOrders = db.prepare('SELECT 1 FROM orders WHERE room_id = ? AND status != ?').get(id, 'cancelled');
  if (hasOrders) return c.json({ error: '该房源还有未取消的订单，不能删除' }, 400);
  db.prepare('DELETE FROM rooms WHERE id = ?').run(id);
  return c.json({ ok: true });
});

app.get('/api/calendar', (c) => {
  const { start, end, room_id } = c.req.query();
  if (!start || !end) return c.json({ error: 'start 和 end 必填' }, 400);

  let sql = `
    SELECT o.id, o.room_id, o.guest_name, o.check_in, o.check_out, o.status, o.total_price
    FROM orders o
    WHERE o.status NOT IN ('cancelled')
      AND o.check_in < ?
      AND o.check_out > ?
  `;
  const params = [end, start];
  if (room_id) {
    sql += ' AND o.room_id = ?';
    params.push(room_id);
  }
  sql += ' ORDER BY o.room_id, o.check_in';
  const orders = db.prepare(sql).all(...params);

  let cleaningSql = `
    SELECT c.id, c.room_id, c.cleaning_date, c.cleaner_name, c.status, c.order_id
    FROM cleanings c
    WHERE c.cleaning_date >= ? AND c.cleaning_date < ?
  `;
  const cleaningParams = [start, end];
  if (room_id) {
    cleaningSql += ' AND c.room_id = ?';
    cleaningParams.push(room_id);
  }
  const cleanings = db.prepare(cleaningSql).all(...cleaningParams);

  const holidays = getHolidays(start, end);

  return c.json({ orders, cleanings, holidays });
});

app.get('/api/orders', (c) => {
  const { room_id, status } = c.req.query();
  let sql = `
    SELECT o.*, r.name as room_name
    FROM orders o
    LEFT JOIN rooms r ON o.room_id = r.id
    WHERE 1=1
  `;
  const params = [];
  if (room_id) { sql += ' AND o.room_id = ?'; params.push(room_id); }
  if (status) { sql += ' AND o.status = ?'; params.push(status); }
  sql += ' ORDER BY o.check_in DESC';
  const orders = db.prepare(sql).all(...params);
  return c.json(orders);
});

app.get('/api/orders/:id', (c) => {
  const order = db.prepare(`
    SELECT o.*, r.name as room_name
    FROM orders o
    LEFT JOIN rooms r ON o.room_id = r.id
    WHERE o.id = ?
  `).get(c.req.param('id'));
  if (!order) return c.json({ error: '订单不存在' }, 404);
  return c.json(order);
});

app.post('/api/orders/check-price', async (c) => {
  const body = await c.req.json();
  const { room_id, check_in, check_out } = body;
  if (!room_id || !check_in || !check_out) {
    return c.json({ error: '缺少参数' }, 400);
  }
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(room_id);
  if (!room) return c.json({ error: '房源不存在' }, 404);
  if (check_in >= check_out) return c.json({ error: '入住日期必须早于退房日期' }, 400);

  const { total, nights } = calculatePrice(room, check_in, check_out);
  const collisions = checkCollision(room_id, check_in, check_out);
  const available = collisions.length === 0;

  return c.json({ total, nights, available, collisions });
});

app.post('/api/orders', async (c) => {
  const body = await c.req.json();
  const { room_id, guest_name, guest_phone, check_in, check_out, cleaner_name } = body;

  if (!room_id || !guest_name || !check_in || !check_out) {
    return c.json({ error: '缺少必填字段' }, 400);
  }
  if (check_in >= check_out) return c.json({ error: '入住日期必须早于退房日期' }, 400);

  try {
    const orderId = createOrder(
      parseInt(room_id),
      guest_name,
      guest_phone || '',
      check_in,
      check_out,
      cleaner_name || '清洁阿姨'
    );

    const order = db.prepare(`
      SELECT o.*, r.name as room_name
      FROM orders o
      LEFT JOIN rooms r ON o.room_id = r.id
      WHERE o.id = ?
    `).get(orderId);

    return c.json(order);
  } catch (e) {
    const msg = e.message;
    if (msg.includes('UNIQUE') || msg.includes('唯一索引') || msg.includes('room_dates')) {
      const collisions = checkCollision(parseInt(room_id), check_in, check_out);
      return c.json({ error: '日期冲突，该时段已有订单', collisions }, 409);
    }
    if (msg.includes('清洁阿姨')) {
      return c.json({ error: msg }, 409);
    }
    return c.json({ error: msg }, 400);
  }
});

app.post('/api/orders/:id/cancel', async (c) => {
  const id = parseInt(c.req.param('id'));
  try {
    const { fee, refund, rule } = cancelOrder(id);
    const updated = db.prepare(`
      SELECT o.*, r.name as room_name
      FROM orders o
      LEFT JOIN rooms r ON o.room_id = r.id
      WHERE o.id = ?
    `).get(id);
    return c.json({ ...updated, cancel_rule: rule, cancel_fee: fee, refund_amount: refund });
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
});

app.post('/api/orders/:id/checkin', (c) => {
  const id = c.req.param('id');
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!order) return c.json({ error: '订单不存在' }, 404);
  if (order.status !== 'confirmed') return c.json({ error: '只有已确认订单才能入住' }, 400);

  db.prepare(`UPDATE orders SET status = 'checked_in', updated_at = datetime('now', 'localtime') WHERE id = ?`).run(id);
  const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  return c.json(updated);
});

app.post('/api/orders/:id/checkout', (c) => {
  const id = c.req.param('id');
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!order) return c.json({ error: '订单不存在' }, 404);
  if (order.status !== 'checked_in') return c.json({ error: '只有入住中订单才能退房' }, 400);

  db.prepare(`UPDATE orders SET status = 'checked_out', updated_at = datetime('now', 'localtime') WHERE id = ?`).run(id);
  const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  return c.json(updated);
});

app.get('/api/cleanings', (c) => {
  const { date, room_id, status } = c.req.query();
  let sql = `
    SELECT c.*, r.name as room_name, o.guest_name, o.check_out
    FROM cleanings c
    LEFT JOIN rooms r ON c.room_id = r.id
    LEFT JOIN orders o ON c.order_id = o.id
    WHERE 1=1
  `;
  const params = [];
  if (date) { sql += ' AND c.cleaning_date = ?'; params.push(date); }
  if (room_id) { sql += ' AND c.room_id = ?'; params.push(room_id); }
  if (status) { sql += ' AND c.status = ?'; params.push(status); }
  sql += ' ORDER BY c.cleaning_date';
  const cleanings = db.prepare(sql).all(...params);
  return c.json(cleanings);
});

app.post('/api/cleanings/:id/complete', (c) => {
  const id = c.req.param('id');
  db.prepare(`UPDATE cleanings SET status = 'completed' WHERE id = ?`).run(id);
  const c2 = db.prepare('SELECT * FROM cleanings WHERE id = ?').get(id);
  return c.json(c2);
});

app.post('/api/cleanings', async (c) => {
  const body = await c.req.json();
  const { room_id, cleaning_date, cleaner_name, notes } = body;
  if (!room_id || !cleaning_date) return c.json({ error: '缺少必填字段' }, 400);

  const cleaner = cleaner_name || '清洁阿姨';
  const conflicts = checkCleanerConflict(cleaner, cleaning_date);
  if (conflicts.length > 0) {
    return c.json({ error: `清洁阿姨(${cleaner})当天已有安排`, conflicts }, 409);
  }

  const info = db.prepare(`
    INSERT INTO cleanings (room_id, cleaning_date, cleaner_name, notes, status)
    VALUES (?, ?, ?, ?, 'scheduled')
  `).run(room_id, cleaning_date, cleaner, notes || '');
  const cleaning = db.prepare('SELECT * FROM cleanings WHERE id = ?').get(info.lastInsertRowid);
  return c.json(cleaning);
});

app.get('/api/holidays', (c) => {
  const { start, end } = c.req.query();
  const holidays = getHolidays(start, end);
  return c.json(holidays);
});

app.post('/api/holidays', async (c) => {
  const body = await c.req.json();
  const { date, start, end, name } = body;
  if (start && end) {
    const count = addHolidayRange(start, end, name || '');
    return c.json({ ok: true, count, name: name || '' });
  }
  if (!date) return c.json({ error: '日期必填' }, 400);
  const ok = addHoliday(date, name || '');
  if (!ok) return c.json({ error: '该日期已设置为节假日' }, 400);
  return c.json({ ok: true, date, name: name || '' });
});

app.delete('/api/holidays/:name', (c) => {
  const name = decodeURIComponent(c.req.param('name'));
  const ok = removeHolidayByName(name);
  if (!ok) return c.json({ error: '未找到该节假日' }, 404);
  return c.json({ ok: true });
});

app.get('/api/stats/monthly', (c) => {
  const { year, month } = c.req.query();
  const now = new Date();
  const y = year ? parseInt(year) : now.getFullYear();
  const m = month ? parseInt(month) : now.getMonth() + 1;

  const monthStart = `${y}-${String(m).padStart(2, '0')}-01`;
  const nextMonth = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  const daysInMonth = diffDays(monthStart, nextMonth);

  const rooms = db.prepare('SELECT id, name FROM rooms ORDER BY id').all();

  const result = rooms.map(room => {
    const orders = db.prepare(`
      SELECT * FROM orders
      WHERE room_id = ?
        AND status NOT IN ('cancelled')
        AND check_in < ?
        AND check_out > ?
    `).all(room.id, nextMonth, monthStart);

    let occupiedNights = 0;
    let revenue = 0;

    for (const order of orders) {
      const overlapStart = order.check_in > monthStart ? order.check_in : monthStart;
      const overlapEnd = order.check_out < nextMonth ? order.check_out : nextMonth;
      const nights = diffDays(overlapStart, overlapEnd);
      occupiedNights += nights;

      const totalNights = diffDays(order.check_in, order.check_out);
      const monthRatio = nights / totalNights;
      revenue += Math.round(order.total_price * monthRatio);
    }

    const occupancyRate = daysInMonth > 0 ? (occupiedNights / (daysInMonth * 1) * 100).toFixed(1) : 0;

    return {
      room_id: room.id,
      room_name: room.name,
      occupied_nights: occupiedNights,
      total_nights: daysInMonth,
      occupancy_rate: parseFloat(occupancyRate),
      revenue: revenue,
    };
  });

  const total = {
    total_revenue: result.reduce((s, r) => s + r.revenue, 0),
    total_occupied_nights: result.reduce((s, r) => s + r.occupied_nights, 0),
    avg_occupancy_rate: rooms.length > 0
      ? parseFloat((result.reduce((s, r) => s + r.occupancy_rate, 0) / rooms.length).toFixed(1))
      : 0,
  };

  return c.json({ year: y, month: m, days_in_month: daysInMonth, rooms: result, total });
});

app.use('/*', serveStatic({ root: path.join(__dirname, 'public') }));

const port = 8888;
console.log(`民宿管理系统启动中...`);
console.log(`http://localhost:${port}`);

serve({
  fetch: app.fetch,
  port,
});
