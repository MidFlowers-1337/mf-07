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
  yuanToFen,
  fenToYuan,
  addPayment,
  getPayments,
  getOrderFinance,
  collectDeposit,
  refundDeposit,
  getMonthlyFinanceReport,
  exportMonthlyFinanceCSV,
  getHostMonthlyReport,
  exportHostMonthlyReportCSV,
  addGuest,
  updateGuest,
  deleteGuest,
  getGuests,
  getGuestFullIdNumber,
  getOrderGuestSummary,
  parseIdCard,
  validateIdNumber,
  checkGuestCapacity,
  maskIdNumber,
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
  const { name, capacity, bedrooms, facilities, check_in_time, check_out_time, weekday_price, weekend_price, holiday_price, deposit_amount } = body;
  if (!name) return c.json({ error: '房源名称必填' }, 400);

  const depositCents = yuanToFen(deposit_amount || 0);

  const info = db.prepare(`
    INSERT INTO rooms (name, capacity, bedrooms, facilities, check_in_time, check_out_time, weekday_price, weekend_price, holiday_price, deposit_amount_cents)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name,
    capacity || 2,
    bedrooms || 1,
    facilities || '',
    check_in_time || '14:00',
    check_out_time || '12:00',
    weekday_price || 200,
    weekend_price || 300,
    holiday_price || 400,
    depositCents
  );
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(info.lastInsertRowid);
  return c.json(room);
});

app.put('/api/rooms/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const existing = db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);
  if (!existing) return c.json({ error: '房源不存在' }, 404);

  const depositCents = body.deposit_amount !== undefined ? yuanToFen(body.deposit_amount) : (Number(existing.deposit_amount_cents) || 0);

  db.prepare(`
    UPDATE rooms SET
      name = ?, capacity = ?, bedrooms = ?, facilities = ?,
      check_in_time = ?, check_out_time = ?,
      weekday_price = ?, weekend_price = ?, holiday_price = ?,
      deposit_amount_cents = ?
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
    depositCents,
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

  for (const o of orders) {
    try {
      const fin = getOrderFinance(o.id);
      o.finance = fin;
    } catch (e) {}
    try {
      o.guests = getOrderGuestSummary(o.id);
    } catch (e) {}
  }

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

  try {
    order.finance = getOrderFinance(order.id);
    order.payments = getPayments(order.id);
    order.guests = getOrderGuestSummary(order.id);
  } catch (e) {}

  return c.json(order);
});

app.get('/api/orders/:id/guests', (c) => {
  const orderId = parseInt(c.req.param('id'));
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return c.json({ error: '订单不存在' }, 404);

  try {
    const summary = getOrderGuestSummary(orderId);
    return c.json(summary);
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
});

app.post('/api/orders/:id/guests', async (c) => {
  const orderId = parseInt(c.req.param('id'));
  const body = await c.req.json();
  const { name, id_type, id_number, phone, is_primary } = body;

  try {
    const result = addGuest(orderId, {
      name,
      id_type: id_type || 'id_card',
      id_number,
      phone: phone || '',
      is_primary: is_primary || 0
    });
    const guest = db.prepare('SELECT * FROM guests WHERE id = ?').get(result.id);
    guest.id_number = maskIdNumber(guest.id_number, guest.id_type);
    return c.json({ ...result, guest });
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
});

app.post('/api/guests/parse-id-card', async (c) => {
  const body = await c.req.json();
  const { id_number } = body;
  if (!id_number) return c.json({ error: '身份证号不能为空' }, 400);

  const validation = validateIdNumber(id_number, 'id_card', false);
  if (!validation.valid) {
    return c.json({ error: validation.error }, 400);
  }

  const parsed = parseIdCard(id_number.trim());
  if (!parsed) {
    return c.json({ error: '身份证号解析失败' }, 400);
  }

  return c.json(parsed);
});

app.put('/api/guests/:id', async (c) => {
  const guestId = parseInt(c.req.param('id'));
  const body = await c.req.json();
  const { name, id_type, id_number, phone, is_primary } = body;

  try {
    const result = updateGuest(guestId, { name, id_type, id_number, phone, is_primary });
    const guest = db.prepare('SELECT * FROM guests WHERE id = ?').get(guestId);
    guest.id_number = maskIdNumber(guest.id_number, guest.id_type);
    return c.json({ ...result, guest });
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
});

app.delete('/api/guests/:id', (c) => {
  const guestId = parseInt(c.req.param('id'));
  try {
    const result = deleteGuest(guestId);
    return c.json(result);
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
});

app.get('/api/guests/:id/full-id', (c) => {
  const guestId = parseInt(c.req.param('id'));
  const { confirmed } = c.req.query();
  if (confirmed !== 'true') {
    return c.json({ error: '请确认后再查看完整证件号' }, 400);
  }
  try {
    const result = getGuestFullIdNumber(guestId);
    return c.json(result);
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
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
  const depositYuan = fenToYuan(Number(room.deposit_amount_cents) || 0);

  return c.json({ total, nights, available, collisions, deposit: depositYuan });
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

    order.finance = getOrderFinance(orderId);
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
    let body = {};
    try {
      body = await c.req.json();
    } catch (e) {}
    const result = cancelOrder(id, body.cancel_date);
    const updated = db.prepare(`
      SELECT o.*, r.name as room_name
      FROM orders o
      LEFT JOIN rooms r ON o.room_id = r.id
      WHERE o.id = ?
    `).get(id);
    return c.json({ ...updated, cancel_rule: result.rule, cancel_fee: result.fee, refund_amount: result.refund, room_fee_refund: result.room_fee_refund, deposit_refund: result.deposit_refund });
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

app.get('/api/orders/:id/payments', (c) => {
  const id = parseInt(c.req.param('id'));
  try {
    const payments = getPayments(id);
    const finance = getOrderFinance(id);
    return c.json({ payments, finance });
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
});

app.post('/api/orders/:id/payments', async (c) => {
  const id = parseInt(c.req.param('id'));
  const body = await c.req.json();
  const { amount_yuan, amount_fen, type, method, note } = body;

  let cents;
  if (amount_fen !== undefined) {
    cents = Math.round(Number(amount_fen));
  } else if (amount_yuan !== undefined) {
    cents = yuanToFen(amount_yuan);
  } else {
    return c.json({ error: '金额必填' }, 400);
  }

  try {
    const pid = addPayment(id, cents, type, method, note || '');
    const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(pid);
    const finance = getOrderFinance(id);
    return c.json({ payment, finance });
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
});

app.post('/api/orders/:id/collect-deposit', async (c) => {
  const id = parseInt(c.req.param('id'));
  const body = await c.req.json();
  const { amount_yuan, amount_fen, method, note } = body;

  let cents;
  if (amount_fen !== undefined) {
    cents = Math.round(Number(amount_fen));
  } else if (amount_yuan !== undefined) {
    cents = yuanToFen(amount_yuan);
  } else {
    return c.json({ error: '金额必填' }, 400);
  }

  try {
    const pid = collectDeposit(id, cents, method || 'wechat', note || '');
    const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(pid);
    const finance = getOrderFinance(id);
    return c.json({ payment, finance });
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
});

app.post('/api/orders/:id/refund-deposit', async (c) => {
  const id = parseInt(c.req.param('id'));
  const body = await c.req.json();
  const { refund_yuan, refund_fen, deducted_yuan, deducted_fen, deduction_note, method } = body;

  let refundCents;
  if (refund_fen !== undefined) {
    refundCents = Math.round(Number(refund_fen));
  } else if (refund_yuan !== undefined) {
    refundCents = yuanToFen(refund_yuan);
  } else {
    refundCents = 0;
  }

  let deductedCents;
  if (deducted_fen !== undefined) {
    deductedCents = Math.round(Number(deducted_fen));
  } else if (deducted_yuan !== undefined) {
    deductedCents = yuanToFen(deducted_yuan);
  } else {
    deductedCents = 0;
  }

  try {
    const result = refundDeposit(id, refundCents, deductedCents, deduction_note || '', method || 'wechat');
    const finance = getOrderFinance(id);
    const payments = getPayments(id);
    return c.json({ ...result, finance, payments });
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
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

app.get('/api/stats/finance/monthly', (c) => {
  const { year, month } = c.req.query();
  const now = new Date();
  const y = year ? parseInt(year) : now.getFullYear();
  const m = month ? parseInt(month) : now.getMonth() + 1;

  try {
    const report = getMonthlyFinanceReport(y, m);
    return c.json(report);
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
});

app.get('/api/stats/finance/monthly/export', (c) => {
  const { year, month } = c.req.query();
  const now = new Date();
  const y = year ? parseInt(year) : now.getFullYear();
  const m = month ? parseInt(month) : now.getMonth() + 1;

  try {
    const csv = exportMonthlyFinanceCSV(y, m);
    const filename = `finance_${y}_${String(m).padStart(2, '0')}.csv`;
    return c.body(csv, 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
});

app.get('/api/host/report/monthly', (c) => {
  const { year, month } = c.req.query();
  const now = new Date();
  const y = year ? parseInt(year) : now.getFullYear();
  const m = month ? parseInt(month) : now.getMonth() + 1;

  try {
    const report = getHostMonthlyReport(y, m);
    return c.json(report);
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
});

app.get('/api/host/report/monthly/export', (c) => {
  const { year, month } = c.req.query();
  const now = new Date();
  const y = year ? parseInt(year) : now.getFullYear();
  const m = month ? parseInt(month) : now.getMonth() + 1;

  try {
    const csv = exportHostMonthlyReportCSV(y, m);
    const filename = `host_report_${y}_${String(m).padStart(2, '0')}.csv`;
    return c.body(csv, 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
});

app.get('/api/refund/tiers', (c) => {
  const { getAllRefundTiers } = require('./services/refund_policy');
  return c.json({
    tiers: getAllRefundTiers(),
    platform_fee_rate: 10,
  });
});

app.use('/*', serveStatic({ root: path.join(__dirname, 'public') }));

const port = 8888;
console.log(`民宿管理系统启动中...`);
console.log(`http://localhost:${port}`);

serve({
  fetch: app.fetch,
  port,
});
