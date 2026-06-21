const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'data.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      capacity INTEGER NOT NULL DEFAULT 2,
      bedrooms INTEGER NOT NULL DEFAULT 1,
      facilities TEXT DEFAULT '',
      check_in_time TEXT DEFAULT '14:00',
      check_out_time TEXT DEFAULT '12:00',
      weekday_price REAL NOT NULL DEFAULT 200,
      weekend_price REAL NOT NULL DEFAULT 300,
      holiday_price REAL NOT NULL DEFAULT 400,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER NOT NULL,
      guest_name TEXT NOT NULL,
      guest_phone TEXT,
      check_in TEXT NOT NULL,
      check_out TEXT NOT NULL,
      nights INTEGER NOT NULL,
      total_price REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      cancel_fee REAL DEFAULT 0,
      refund_amount REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (room_id) REFERENCES rooms(id)
    );

    CREATE INDEX IF NOT EXISTS idx_orders_room_dates ON orders(room_id, check_in, check_out);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

    CREATE TABLE IF NOT EXISTS room_dates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      order_id INTEGER NOT NULL,
      FOREIGN KEY (room_id) REFERENCES rooms(id),
      FOREIGN KEY (order_id) REFERENCES orders(id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_room_dates_unique ON room_dates(room_id, date);
    CREATE INDEX IF NOT EXISTS idx_room_dates_order ON room_dates(order_id);

    CREATE TABLE IF NOT EXISTS cleanings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER NOT NULL,
      order_id INTEGER,
      cleaning_date TEXT NOT NULL,
      cleaner_name TEXT DEFAULT '清洁阿姨',
      status TEXT NOT NULL DEFAULT 'scheduled',
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (room_id) REFERENCES rooms(id),
      FOREIGN KEY (order_id) REFERENCES orders(id)
    );

    CREATE INDEX IF NOT EXISTS idx_cleanings_date ON cleanings(cleaning_date);
    CREATE INDEX IF NOT EXISTS idx_cleanings_room_date ON cleanings(room_id, cleaning_date);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cleanings_cleaner_date ON cleanings(cleaner_name, cleaning_date)
      WHERE status != 'cancelled';

    CREATE TABLE IF NOT EXISTS holidays (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL UNIQUE,
      name TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE INDEX IF NOT EXISTS idx_holidays_date ON holidays(date);
  `);

  try { db.exec('ALTER TABLE rooms ADD COLUMN deposit_amount_cents INTEGER NOT NULL DEFAULT 0'); } catch (e) {}
  try { db.exec('ALTER TABLE orders ADD COLUMN deposit_amount_cents INTEGER NOT NULL DEFAULT 0'); } catch (e) {}

  db.exec(`
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      amount_cents INTEGER NOT NULL,
      type TEXT NOT NULL,
      method TEXT NOT NULL DEFAULT 'wechat',
      note TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (order_id) REFERENCES orders(id)
    );
  `);
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id)'); } catch (e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_payments_created ON payments(created_at)'); } catch (e) {}
}

function yuanToFen(yuan) {
  return Math.round(Number(yuan) * 100);
}

function fenToYuan(fen) {
  return Math.round(Number(fen)) / 100;
}

function dateToStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function strToDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addDays(dateStr, days) {
  const d = strToDate(dateStr);
  d.setDate(d.getDate() + days);
  return dateToStr(d);
}

function diffDays(checkIn, checkOut) {
  const a = strToDate(checkIn);
  const b = strToDate(checkOut);
  return Math.round((b - a) / (1000 * 60 * 60 * 24));
}

function isWeekend(dateStr) {
  const d = strToDate(dateStr);
  const day = d.getDay();
  return day === 0 || day === 6;
}

function isHoliday(dateStr) {
  const row = db.prepare('SELECT 1 FROM holidays WHERE date = ?').get(dateStr);
  return !!row;
}

function getHolidays(start, end) {
  if (start && end) {
    return db.prepare('SELECT date, name as holiday FROM holidays WHERE date >= ? AND date < ? ORDER BY date').all(start, end);
  }
  return db.prepare('SELECT date, name as holiday FROM holidays ORDER BY date').all();
}

function addHoliday(date, name = '') {
  const info = db.prepare('INSERT OR IGNORE INTO holidays (date, name) VALUES (?, ?)').run(date, name);
  return info.changes > 0;
}

function addHolidayRange(start, end, name = '') {
  const dates = datesBetween(start, addDays(end, 1));
  let count = 0;
  for (const d of dates) {
    if (addHoliday(d, name)) count++;
  }
  return count;
}

function removeHoliday(date) {
  const info = db.prepare('DELETE FROM holidays WHERE date = ?').run(date);
  return info.changes > 0;
}

function removeHolidayByName(name) {
  const info = db.prepare('DELETE FROM holidays WHERE holiday = ?').run(name);
  return info.changes > 0;
}

function datesBetween(checkIn, checkOut) {
  const dates = [];
  let cur = checkIn;
  while (cur < checkOut) {
    dates.push(cur);
    cur = addDays(cur, 1);
  }
  return dates;
}

function hasOverlap(existingIn, existingOut, newIn, newOut) {
  return newIn < existingOut && newOut > existingIn;
}

function calculatePrice(room, checkIn, checkOut) {
  const nights = datesBetween(checkIn, checkOut);
  let total = 0;
  for (const night of nights) {
    if (isHoliday(night)) {
      total += room.holiday_price;
    } else if (isWeekend(night)) {
      total += room.weekend_price;
    } else {
      total += room.weekday_price;
    }
  }
  return { total, nights: nights.length };
}

function calcCancelFee(room, checkIn, checkOut, cancelDate) {
  const daysUntilCheckIn = diffDays(cancelDate, checkIn);
  const { total } = calculatePrice(room, checkIn, checkOut);

  if (daysUntilCheckIn >= 7) {
    return { fee: 0, refund: total, rule: '提前7天以上，全额退款' };
  } else if (daysUntilCheckIn >= 3) {
    const fee = Math.round(total * 0.5);
    return { fee, refund: total - fee, rule: '提前3-7天，收取50%违约金' };
  } else if (daysUntilCheckIn >= 1) {
    const fee = Math.round(total * 0.8);
    return { fee, refund: total - fee, rule: '提前1-3天，收取80%违约金' };
  } else {
    return { fee: total, refund: 0, rule: '当天或入住后，不予退款' };
  }
}

function checkCollision(roomId, checkIn, checkOut, excludeOrderId = null) {
  let sql = `
    SELECT o.id, o.guest_name, o.check_in, o.check_out, o.status
    FROM orders o
    WHERE o.room_id = ?
      AND o.status NOT IN ('cancelled')
      AND o.check_in < ?
      AND o.check_out > ?
  `;
  const params = [roomId, checkOut, checkIn];
  if (excludeOrderId) {
    sql += ' AND o.id != ?';
    params.push(excludeOrderId);
  }
  const stmt = db.prepare(sql);
  return stmt.all(...params);
}

function checkCleanerConflict(cleanerName, cleaningDate, excludeId = null) {
  let sql = `
    SELECT * FROM cleanings
    WHERE cleaner_name = ?
      AND cleaning_date = ?
      AND status != 'cancelled'
  `;
  const params = [cleanerName, cleaningDate];
  if (excludeId) {
    sql += ' AND id != ?';
    params.push(excludeId);
  }
  return db.prepare(sql).all(params);
}

function createOrder(roomId, guestName, guestPhone, checkIn, checkOut, cleanerName = '清洁阿姨') {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
  if (!room) throw new Error('房源不存在');
  if (checkIn >= checkOut) throw new Error('入住日期必须早于退房日期');

  const { total, nights } = calculatePrice(room, checkIn, checkOut);
  const depositCents = Number(room.deposit_amount_cents) || 0;

  const cleanerConflict = checkCleanerConflict(cleanerName, checkOut);
  if (cleanerConflict.length > 0) {
    throw new Error(`清洁阿姨(${cleanerName})${checkOut}已有安排，请换个时间或换个阿姨`);
  }

  const insertOrder = db.prepare(`
    INSERT INTO orders (room_id, guest_name, guest_phone, check_in, check_out, nights, total_price, status, deposit_amount_cents)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', ?)
  `);

  const insertDate = db.prepare(`
    INSERT INTO room_dates (room_id, date, order_id) VALUES (?, ?, ?)
  `);

  const insertCleaning = db.prepare(`
    INSERT INTO cleanings (room_id, order_id, cleaning_date, cleaner_name, status)
    VALUES (?, ?, ?, ?, 'scheduled')
  `);

  const nightsArr = datesBetween(checkIn, checkOut);

  const result = db.transaction(() => {
    const info = insertOrder.run(roomId, guestName, guestPhone || '', checkIn, checkOut, nights, total, depositCents);
    const orderId = info.lastInsertRowid;

    for (const night of nightsArr) {
      insertDate.run(roomId, night, orderId);
    }

    insertCleaning.run(roomId, orderId, checkOut, cleanerName);

    return orderId;
  })();

  return result;
}

function addPayment(orderId, amountCents, type, method, note = '') {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) throw new Error('订单不存在');

  const validTypes = ['room_fee', 'deposit', 'deposit_refund'];
  if (!validTypes.includes(type)) throw new Error('付款类型无效');

  const validMethods = ['wechat', 'cash'];
  if (!validMethods.includes(method)) throw new Error('付款方式无效');

  amountCents = Math.round(Number(amountCents));
  if (amountCents <= 0) throw new Error('金额必须大于0');

  if (type === 'deposit_refund') {
    const fin = getOrderFinance(orderId);
    if (amountCents > fin.deposit_net_cents) {
      throw new Error(`押金退款不能超过已收押金(${fenToYuan(fin.deposit_net_cents)}元)`);
    }
  }

  const info = db.prepare(`
    INSERT INTO payments (order_id, amount_cents, type, method, note)
    VALUES (?, ?, ?, ?, ?)
  `).run(orderId, amountCents, type, method, note || '');

  return info.lastInsertRowid;
}

function getPayments(orderId) {
  return db.prepare(`
    SELECT * FROM payments WHERE order_id = ? ORDER BY id
  `).all(orderId);
}

function getOrderFinance(orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) throw new Error('订单不存在');

  const totalRoomFeeCents = yuanToFen(Number(order.total_price));
  const depositReceivableCents = Number(order.deposit_amount_cents) || 0;

  const rows = db.prepare(`
    SELECT type, SUM(amount_cents) as total
    FROM payments
    WHERE order_id = ?
    GROUP BY type
  `).all(orderId);

  const agg = { room_fee: 0, deposit: 0, deposit_refund: 0 };
  for (const r of rows) {
    agg[r.type] = Number(r.total) || 0;
  }

  const roomFeeReceived = agg.room_fee;
  const roomFeeOwed = Math.max(0, totalRoomFeeCents - roomFeeReceived);

  const depositReceived = agg.deposit;
  const depositRefunded = agg.deposit_refund;
  const depositNet = depositReceived - depositRefunded;
  const depositOwed = Math.max(0, depositReceivableCents - depositReceived);

  const totalReceivable = totalRoomFeeCents + depositReceivableCents;
  const totalReceived = roomFeeReceived + depositReceived;
  const totalOwed = roomFeeOwed + depositOwed;

  return {
    total_room_fee_cents: totalRoomFeeCents,
    total_room_fee_yuan: fenToYuan(totalRoomFeeCents),
    room_fee_received_cents: roomFeeReceived,
    room_fee_received_yuan: fenToYuan(roomFeeReceived),
    room_fee_owed_cents: roomFeeOwed,
    room_fee_owed_yuan: fenToYuan(roomFeeOwed),

    deposit_receivable_cents: depositReceivableCents,
    deposit_receivable_yuan: fenToYuan(depositReceivableCents),
    deposit_received_cents: depositReceived,
    deposit_received_yuan: fenToYuan(depositReceived),
    deposit_refunded_cents: depositRefunded,
    deposit_refunded_yuan: fenToYuan(depositRefunded),
    deposit_net_cents: depositNet,
    deposit_net_yuan: fenToYuan(depositNet),
    deposit_owed_cents: depositOwed,
    deposit_owed_yuan: fenToYuan(depositOwed),

    total_receivable_cents: totalReceivable,
    total_receivable_yuan: fenToYuan(totalReceivable),
    total_received_cents: totalReceived,
    total_received_yuan: fenToYuan(totalReceived),
    total_owed_cents: totalOwed,
    total_owed_yuan: fenToYuan(totalOwed),
  };
}

function collectDeposit(orderId, amountCents, method, note = '') {
  return addPayment(orderId, amountCents, 'deposit', method, note);
}

function refundDeposit(orderId, refundCents, deductedCents, deductionNote, method) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) throw new Error('订单不存在');

  refundCents = Math.round(Number(refundCents)) || 0;
  deductedCents = Math.round(Number(deductedCents)) || 0;

  if (refundCents < 0) throw new Error('退款金额不能为负');
  if (deductedCents < 0) throw new Error('扣款金额不能为负');

  const fin = getOrderFinance(orderId);
  const totalOut = refundCents + deductedCents;
  if (totalOut > fin.deposit_net_cents) {
    throw new Error(`退款+扣款(${fenToYuan(totalOut)}元)超过当前押金余额(${fenToYuan(fin.deposit_net_cents)}元)`);
  }

  db.transaction(() => {
    if (deductedCents > 0) {
      db.prepare(`
        INSERT INTO payments (order_id, amount_cents, type, method, note)
        VALUES (?, ?, 'deposit_refund', ?, ?)
      `).run(orderId, deductedCents, method || 'cash', deductionNote || '押金扣款');
    }
    if (refundCents > 0) {
      db.prepare(`
        INSERT INTO payments (order_id, amount_cents, type, method, note)
        VALUES (?, ?, 'deposit_refund', ?, ?)
      `).run(orderId, refundCents, method || 'cash', '退还押金');
    }
  })();

  return { refund_cents: refundCents, deducted_cents: deductedCents };
}

function cancelOrder(orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) throw new Error('订单不存在');
  if (order.status === 'cancelled') throw new Error('订单已取消');

  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(order.room_id);
  const today = dateToStr(new Date());
  const { fee, refund, rule } = calcCancelFee(room, order.check_in, order.check_out, today);

  const fin = getOrderFinance(orderId);
  const depositRefund = fin.deposit_net_cents;
  const totalRefund = refund + fenToYuan(depositRefund);

  const updateOrder = db.prepare(`
    UPDATE orders SET
      status = 'cancelled',
      cancel_fee = ?,
      refund_amount = ?,
      updated_at = datetime('now', 'localtime')
    WHERE id = ?
  `);

  const deleteDates = db.prepare('DELETE FROM room_dates WHERE order_id = ?');

  const cancelCleaning = db.prepare(`
    UPDATE cleanings SET status = 'cancelled' WHERE order_id = ?
  `);

  db.transaction(() => {
    updateOrder.run(fee, totalRefund, orderId);
    deleteDates.run(orderId);
    cancelCleaning.run(orderId);

    if (depositRefund > 0) {
      db.prepare(`
        INSERT INTO payments (order_id, amount_cents, type, method, note)
        VALUES (?, ?, 'deposit_refund', 'wechat', ?)
      `).run(orderId, depositRefund, '退订退还押金');
    }
  })();

  return {
    fee,
    refund: totalRefund,
    room_fee_refund: refund,
    deposit_refund: fenToYuan(depositRefund),
    rule,
  };
}

function getMonthlyFinanceReport(year, month) {
  const y = parseInt(year);
  const m = parseInt(month);
  const monthStart = `${y}-${String(m).padStart(2, '0')}-01`;
  const nextMonth = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;

  const rooms = db.prepare('SELECT id, name FROM rooms ORDER BY id').all();

  const rows = db.prepare(`
    SELECT
      o.room_id,
      o.id as order_id,
      o.total_price,
      COALESCE(o.deposit_amount_cents, 0) as deposit_amount_cents,
      p.id as pay_id,
      p.amount_cents,
      p.type,
      p.created_at
    FROM orders o
    LEFT JOIN payments p ON p.order_id = o.id
    WHERE o.room_id IS NOT NULL
      AND o.status NOT IN ('cancelled')
      AND (
        (o.check_in < ? AND o.check_out > ?)
        OR (p.created_at >= ? AND p.created_at < ?)
      )
  `).all(nextMonth, monthStart, monthStart, nextMonth);

  const byRoom = {};
  for (const r of rooms) {
    byRoom[r.id] = {
      room_id: r.id,
      room_name: r.name,
      room_fee_receivable_cents: 0,
      room_fee_received_cents: 0,
      room_fee_owed_cents: 0,
      deposit_receivable_cents: 0,
      deposit_in_cents: 0,
      deposit_out_cents: 0,
      deposit_net_cents: 0,
      total_receivable_cents: 0,
      total_received_cents: 0,
      total_owed_cents: 0,
    };
  }

  const orderFinance = {};
  for (const row of rows) {
    if (!orderFinance[row.order_id]) {
      orderFinance[row.order_id] = {
        room_id: row.room_id,
        total_price: Number(row.total_price),
        deposit_amount_cents: Number(row.deposit_amount_cents) || 0,
        payments: [],
      };
    }
    if (row.pay_id) {
      orderFinance[row.order_id].payments.push({
        amount_cents: Number(row.amount_cents),
        type: row.type,
        created_at: row.created_at,
      });
    }
  }

  for (const oid in orderFinance) {
    const of = orderFinance[oid];
    const room = byRoom[of.room_id];
    if (!room) continue;

    const roomFeeCents = yuanToFen(of.total_price);
    const depositCents = of.deposit_amount_cents;

    let paidRoom = 0, paidDep = 0, refundDep = 0;
    for (const p of of.payments) {
      const inMonth = p.created_at >= monthStart && p.created_at < nextMonth;
      if (!inMonth) continue;
      if (p.type === 'room_fee') paidRoom += p.amount_cents;
      else if (p.type === 'deposit') paidDep += p.amount_cents;
      else if (p.type === 'deposit_refund') refundDep += p.amount_cents;
    }

    const overlapStart = of.check_in_for_calc || null;
    room.room_fee_receivable_cents += roomFeeCents;
    room.deposit_receivable_cents += depositCents;
    room.room_fee_received_cents += paidRoom;
    room.deposit_in_cents += paidDep;
    room.deposit_out_cents += refundDep;
  }

  const allOrders = db.prepare(`
    SELECT id, room_id, total_price, COALESCE(deposit_amount_cents, 0) as deposit_amount_cents, check_in, check_out
    FROM orders
    WHERE status NOT IN ('cancelled')
  `).all();

  const paidMap = {};
  const paidRows = db.prepare(`
    SELECT order_id, type, SUM(amount_cents) as total
    FROM payments
    GROUP BY order_id, type
  `).all();
  for (const pr of paidRows) {
    if (!paidMap[pr.order_id]) paidMap[pr.order_id] = { room_fee: 0, deposit: 0, deposit_refund: 0 };
    paidMap[pr.order_id][pr.type] = Number(pr.total) || 0;
  }

  for (const room of rooms) {
    const r = byRoom[room.id];
    r.room_fee_receivable_cents = 0;
    r.deposit_receivable_cents = 0;
    r.room_fee_received_cents = 0;
    r.deposit_in_cents = 0;
    r.deposit_out_cents = 0;
  }

  for (const o of allOrders) {
    const r = byRoom[o.room_id];
    if (!r) continue;
    if (o.check_in >= nextMonth || o.check_out <= monthStart) continue;

    const roomFeeCents = yuanToFen(Number(o.total_price));
    const depositCents = Number(o.deposit_amount_cents) || 0;

    const totalNights = diffDays(o.check_in, o.check_out);
    const overlapStart = o.check_in > monthStart ? o.check_in : monthStart;
    const overlapEnd = o.check_out < nextMonth ? o.check_out : nextMonth;
    const overlapNights = diffDays(overlapStart, overlapEnd);
    const ratio = totalNights > 0 ? overlapNights / totalNights : 0;

    r.room_fee_receivable_cents += Math.round(roomFeeCents * ratio);

    const paid = paidMap[o.id] || { room_fee: 0, deposit: 0, deposit_refund: 0 };
    const allPayments = db.prepare(`
      SELECT amount_cents, type, created_at FROM payments WHERE order_id = ?
    `).all(o.id);

    for (const p of allPayments) {
      if (p.created_at < monthStart || p.created_at >= nextMonth) continue;
      const cents = Number(p.amount_cents);
      if (p.type === 'room_fee') r.room_fee_received_cents += cents;
      else if (p.type === 'deposit') r.deposit_in_cents += cents;
      else if (p.type === 'deposit_refund') r.deposit_out_cents += cents;
    }

    r.deposit_receivable_cents += depositCents;
  }

  for (const room of rooms) {
    const r = byRoom[room.id];
    r.deposit_net_cents = r.deposit_in_cents - r.deposit_out_cents;
    r.room_fee_owed_cents = Math.max(0, r.room_fee_receivable_cents - r.room_fee_received_cents);
    r.deposit_owed_cents = Math.max(0, r.deposit_receivable_cents - r.deposit_in_cents);
    r.total_receivable_cents = r.room_fee_receivable_cents + r.deposit_receivable_cents;
    r.total_received_cents = r.room_fee_received_cents + r.deposit_in_cents;
    r.total_owed_cents = r.room_fee_owed_cents + r.deposit_owed_cents;

    r.room_fee_receivable_yuan = fenToYuan(r.room_fee_receivable_cents);
    r.room_fee_received_yuan = fenToYuan(r.room_fee_received_cents);
    r.room_fee_owed_yuan = fenToYuan(r.room_fee_owed_cents);
    r.deposit_receivable_yuan = fenToYuan(r.deposit_receivable_cents);
    r.deposit_in_yuan = fenToYuan(r.deposit_in_cents);
    r.deposit_out_yuan = fenToYuan(r.deposit_out_cents);
    r.deposit_net_yuan = fenToYuan(r.deposit_net_cents);
    r.deposit_owed_yuan = fenToYuan(r.deposit_owed_cents);
    r.total_receivable_yuan = fenToYuan(r.total_receivable_cents);
    r.total_received_yuan = fenToYuan(r.total_received_cents);
    r.total_owed_yuan = fenToYuan(r.total_owed_cents);
  }

  const roomList = rooms.map(r => byRoom[r.id]);

  const total = {
    room_fee_receivable_yuan: fenToYuan(roomList.reduce((s, r) => s + r.room_fee_receivable_cents, 0)),
    room_fee_received_yuan: fenToYuan(roomList.reduce((s, r) => s + r.room_fee_received_cents, 0)),
    room_fee_owed_yuan: fenToYuan(roomList.reduce((s, r) => s + r.room_fee_owed_cents, 0)),
    deposit_receivable_yuan: fenToYuan(roomList.reduce((s, r) => s + r.deposit_receivable_cents, 0)),
    deposit_in_yuan: fenToYuan(roomList.reduce((s, r) => s + r.deposit_in_cents, 0)),
    deposit_out_yuan: fenToYuan(roomList.reduce((s, r) => s + r.deposit_out_cents, 0)),
    deposit_net_yuan: fenToYuan(roomList.reduce((s, r) => s + r.deposit_net_cents, 0)),
    deposit_owed_yuan: fenToYuan(roomList.reduce((s, r) => s + r.deposit_owed_cents, 0)),
    total_receivable_yuan: fenToYuan(roomList.reduce((s, r) => s + r.total_receivable_cents, 0)),
    total_received_yuan: fenToYuan(roomList.reduce((s, r) => s + r.total_received_cents, 0)),
    total_owed_yuan: fenToYuan(roomList.reduce((s, r) => s + r.total_owed_cents, 0)),
  };

  return { year: y, month: m, rooms: roomList, total };
}

function escapeCSV(val) {
  const s = String(val == null ? '' : val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function exportMonthlyFinanceCSV(year, month) {
  const report = getMonthlyFinanceReport(year, month);

  let lines = [];
  lines.push(`月度财务对账 - ${report.year}年${report.month}月`);
  lines.push('');
  lines.push(['房源', '房费应收(元)', '房费已收(元)', '房费欠款(元)', '押金应收(元)', '押金收入(元)', '押金支出(元)', '押金净额(元)', '押金欠款(元)', '合计应收(元)', '合计已收(元)', '合计欠款(元)'].map(escapeCSV).join(','));

  for (const r of report.rooms) {
    lines.push([
      r.room_name,
      r.room_fee_receivable_yuan,
      r.room_fee_received_yuan,
      r.room_fee_owed_yuan,
      r.deposit_receivable_yuan,
      r.deposit_in_yuan,
      r.deposit_out_yuan,
      r.deposit_net_yuan,
      r.deposit_owed_yuan,
      r.total_receivable_yuan,
      r.total_received_yuan,
      r.total_owed_yuan,
    ].map(escapeCSV).join(','));
  }

  lines.push([
    '合计',
    report.total.room_fee_receivable_yuan,
    report.total.room_fee_received_yuan,
    report.total.room_fee_owed_yuan,
    report.total.deposit_receivable_yuan,
    report.total.deposit_in_yuan,
    report.total.deposit_out_yuan,
    report.total.deposit_net_yuan,
    report.total.deposit_owed_yuan,
    report.total.total_receivable_yuan,
    report.total.total_received_yuan,
    report.total.total_owed_yuan,
  ].map(escapeCSV).join(','));

  lines.push('');
  lines.push('导出时间,' + new Date().toLocaleString('zh-CN'));

  return lines.join('\n');
}

module.exports = {
  db,
  initDb,
  yuanToFen,
  fenToYuan,
  dateToStr,
  strToDate,
  addDays,
  diffDays,
  isWeekend,
  isHoliday,
  getHolidays,
  addHoliday,
  addHolidayRange,
  removeHoliday,
  removeHolidayByName,
  datesBetween,
  hasOverlap,
  calculatePrice,
  calcCancelFee,
  checkCollision,
  checkCleanerConflict,
  createOrder,
  cancelOrder,
  addPayment,
  getPayments,
  getOrderFinance,
  collectDeposit,
  refundDeposit,
  getMonthlyFinanceReport,
  exportMonthlyFinanceCSV,
};
