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

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS guests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        id_type TEXT NOT NULL DEFAULT 'id_card',
        id_number TEXT NOT NULL,
        phone TEXT DEFAULT '',
        is_primary INTEGER NOT NULL DEFAULT 0,
        birth_date TEXT,
        gender TEXT,
        created_at TEXT DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT DEFAULT (datetime('now', 'localtime')),
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
      );
    `);
  } catch (e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_guests_order ON guests(order_id)'); } catch (e) {}
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_guests_order_idnum ON guests(order_id, id_number)'); } catch (e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_guests_idnum ON guests(id_number)'); } catch (e) {}

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

    db.prepare(`
      INSERT INTO guests (order_id, name, id_type, id_number, phone, is_primary, birth_date, gender)
      VALUES (?, ?, 'id_card', ?, ?, 1, NULL, NULL)
    `).run(orderId, guestName, '', guestPhone || '');

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
  const deleteGuests = db.prepare('DELETE FROM guests WHERE order_id = ?');

  const cancelCleaning = db.prepare(`
    UPDATE cleanings SET status = 'cancelled' WHERE order_id = ?
  `);

  db.transaction(() => {
    updateOrder.run(fee, totalRefund, orderId);
    deleteDates.run(orderId);
    deleteGuests.run(orderId);
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
      deposit_owed_cents: 0,
      total_receivable_cents: 0,
      total_received_cents: 0,
      total_owed_cents: 0,
    };
  }

  const allOrders = db.prepare(`
    SELECT id, room_id, total_price, COALESCE(deposit_amount_cents, 0) as deposit_amount_cents,
           check_in, check_out, status
    FROM orders
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

  for (const o of allOrders) {
    if (o.status === 'cancelled') continue;
    const r = byRoom[o.room_id];
    if (!r) continue;

    const hasStayNights = !(o.check_in >= nextMonth || o.check_out <= monthStart);
    const isDepositMonth = o.check_in >= monthStart && o.check_in < nextMonth;
    if (!hasStayNights && !isDepositMonth) continue;

    const totalRoomFeeCents = yuanToFen(Number(o.total_price));
    const depositCents = Number(o.deposit_amount_cents) || 0;
    const paid = paidMap[o.id] || { room_fee: 0, deposit: 0, deposit_refund: 0 };

    if (hasStayNights && totalRoomFeeCents > 0) {
      const totalNights = diffDays(o.check_in, o.check_out);
      const overlapStart = o.check_in > monthStart ? o.check_in : monthStart;
      const overlapEnd = o.check_out < nextMonth ? o.check_out : nextMonth;
      const overlapNights = diffDays(overlapStart, overlapEnd);
      const ratio = totalNights > 0 ? overlapNights / totalNights : 0;

      const monthlyReceivable = Math.round(totalRoomFeeCents * ratio);
      const monthlyReceived = Math.round(paid.room_fee * ratio);
      const monthlyOwed = Math.max(0, monthlyReceivable - monthlyReceived);

      r.room_fee_receivable_cents += monthlyReceivable;
      r.room_fee_received_cents += monthlyReceived;
      r.room_fee_owed_cents += monthlyOwed;
    }

    if (isDepositMonth) {
      r.deposit_receivable_cents += depositCents;
      r.deposit_in_cents += paid.deposit;
      r.deposit_out_cents += paid.deposit_refund;
    }
  }

  for (const room of rooms) {
    const r = byRoom[room.id];
    r.deposit_net_cents = r.deposit_in_cents - r.deposit_out_cents;
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

function validateIdCardChecksum(idNumber) {
  if (!/^\d{17}[\dXx]$/.test(idNumber)) return false;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checkCodes = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    sum += parseInt(idNumber.charAt(i)) * weights[i];
  }
  const expectedCode = checkCodes[sum % 11];
  const actualCode = idNumber.charAt(17).toUpperCase();
  return actualCode === expectedCode;
}

function parseIdCard(idNumber) {
  if (!validateIdCardChecksum(idNumber)) return null;
  const birthDate = idNumber.substring(6, 10) + '-' + idNumber.substring(10, 12) + '-' + idNumber.substring(12, 14);
  const genderCode = parseInt(idNumber.charAt(16));
  const gender = genderCode % 2 === 1 ? '男' : '女';
  return { birth_date: birthDate, gender };
}

function maskIdNumber(idNumber, idType) {
  if (!idNumber) return '';
  if (idType === 'id_card' && idNumber.length === 18) {
    return idNumber.substring(0, 6) + '********' + idNumber.substring(14, 18);
  }
  if (idNumber.length <= 10) {
    return idNumber.charAt(0) + '*'.repeat(Math.max(0, idNumber.length - 2)) + (idNumber.length > 1 ? idNumber.charAt(idNumber.length - 1) : '');
  }
  return idNumber.substring(0, 4) + '*'.repeat(idNumber.length - 8) + idNumber.substring(idNumber.length - 4);
}

function validateIdNumber(idNumber, idType, allowEmpty = false) {
  if (!idNumber || !idNumber.trim()) {
    if (allowEmpty) return { valid: true };
    return { valid: false, error: '证件号不能为空' };
  }
  const idNum = idNumber.trim();

  if (idType === 'id_card') {
    if (!/^\d{17}[\dXx]$/.test(idNum)) {
      return { valid: false, error: '身份证号必须是18位，最后一位可以是X' };
    }
    if (!validateIdCardChecksum(idNum)) {
      return { valid: false, error: '身份证号校验位不正确' };
    }
    const birthStr = idNum.substring(6, 10) + '-' + idNum.substring(10, 12) + '-' + idNum.substring(12, 14);
    const birthDate = new Date(birthStr);
    if (isNaN(birthDate.getTime()) || birthDate > new Date()) {
      return { valid: false, error: '身份证号出生日期无效' };
    }
  } else if (idType === 'passport') {
    if (idNum.length < 6 || idNum.length > 15) {
      return { valid: false, error: '护照号长度不正确（通常6-15位）' };
    }
  } else if (idType === 'hk_mo_taiwan') {
    if (!/^[A-Za-z0-9]{8,11}$/.test(idNum)) {
      return { valid: false, error: '港澳台通行证号长度不正确（通常8-11位）' };
    }
  } else {
    return { valid: false, error: '无效的证件类型' };
  }

  return { valid: true };
}

function checkIdCollision(orderId, idNumber, checkIn, checkOut) {
  const sql = `
    SELECT DISTINCT o.id, o.guest_name, o.check_in, o.check_out, r.name as room_name
    FROM guests g
    JOIN orders o ON g.order_id = o.id
    JOIN rooms r ON o.room_id = r.id
    WHERE g.id_number = ?
      AND o.id != ?
      AND o.status NOT IN ('cancelled')
      AND o.check_in < ?
      AND o.check_out > ?
  `;
  const collisions = db.prepare(sql).all(idNumber, orderId, checkOut, checkIn);
  return collisions;
}

function checkGuestCapacity(orderId) {
  const order = db.prepare('SELECT room_id, status FROM orders WHERE id = ?').get(orderId);
  if (!order) throw new Error('订单不存在');

  const room = db.prepare('SELECT capacity FROM rooms WHERE id = ?').get(order.room_id);
  if (!room) throw new Error('房源不存在');

  const guestCount = db.prepare('SELECT COUNT(*) as cnt FROM guests WHERE order_id = ?').get(orderId).cnt;
  const capacity = room.capacity;

  return {
    guest_count: guestCount,
    capacity: capacity,
    is_over: guestCount > capacity,
    over_count: Math.max(0, guestCount - capacity)
  };
}

function canModifyGuests(order) {
  if (!order) return false;
  if (order.status === 'cancelled') return false;
  if (order.status === 'checked_out') return false;
  return true;
}

function addGuest(orderId, guestData, allowEmptyId = false) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) throw new Error('订单不存在');
  if (!canModifyGuests(order)) throw new Error('当前订单状态不能修改入住人');

  const { name, id_type = 'id_card', id_number, phone = '', is_primary = 0 } = guestData;

  if (!name || !name.trim()) throw new Error('姓名不能为空');

  const idNumTrimmed = id_number ? id_number.trim() : '';
  if (!idNumTrimmed && !allowEmptyId) {
    throw new Error('证件号不能为空');
  }

  const idValidation = validateIdNumber(id_number, id_type, allowEmptyId);
  if (!idValidation.valid) throw new Error(idValidation.error);

  let existing = null;
  if (idNumTrimmed) {
    existing = db.prepare('SELECT id FROM guests WHERE order_id = ? AND id_number = ?').get(orderId, idNumTrimmed);
  }
  if (existing) throw new Error('同一订单中证件号不能重复');

  const preCapacity = checkGuestCapacity(orderId);
  if (preCapacity.guest_count + 1 > preCapacity.capacity) {
    throw new Error(`入住人数(${preCapacity.guest_count + 1})超过房源最大容量(${preCapacity.capacity})，超员${(preCapacity.guest_count + 1) - preCapacity.capacity}人`);
  }

  let birthDate = null;
  let gender = null;
  if (id_type === 'id_card' && idNumTrimmed) {
    const parsed = parseIdCard(idNumTrimmed);
    if (parsed) {
      birthDate = parsed.birth_date;
      gender = parsed.gender;
    }
  }

  const result = db.transaction(() => {
    if (is_primary) {
      db.prepare('UPDATE guests SET is_primary = 0 WHERE order_id = ?').run(orderId);
    }

    const info = db.prepare(`
      INSERT INTO guests (order_id, name, id_type, id_number, phone, is_primary, birth_date, gender)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(orderId, name.trim(), id_type, idNumTrimmed, phone.trim(), is_primary ? 1 : 0, birthDate, gender);

    const collisions = idNumTrimmed ? checkIdCollision(orderId, idNumTrimmed, order.check_in, order.check_out) : [];
    const res = { id: info.lastInsertRowid, collisions };

    const capacityAfter = checkGuestCapacity(orderId);
    res.capacity = capacityAfter;

    return res;
  })();

  return result;
}

function updateGuest(guestId, guestData) {
  const guest = db.prepare('SELECT * FROM guests WHERE id = ?').get(guestId);
  if (!guest) throw new Error('入住人不存在');

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(guest.order_id);
  if (!order) throw new Error('订单不存在');
  if (!canModifyGuests(order)) throw new Error('当前订单状态不能修改入住人');

  const { name, id_type, id_number, phone, is_primary } = guestData;

  const finalName = (name !== undefined ? name : guest.name).trim();
  const finalIdType = id_type !== undefined ? id_type : guest.id_type;
  const finalIdNumber = (id_number !== undefined ? id_number : guest.id_number).trim();
  const finalPhone = phone !== undefined ? phone.trim() : guest.phone;
  const finalIsPrimary = is_primary !== undefined ? (is_primary ? 1 : 0) : guest.is_primary;

  if (!finalName) throw new Error('姓名不能为空');
  if (!finalIdNumber) throw new Error('证件号不能为空');

  const idValidation = validateIdNumber(finalIdNumber, finalIdType);
  if (!idValidation.valid) throw new Error(idValidation.error);

  const existing = db.prepare('SELECT id FROM guests WHERE order_id = ? AND id_number = ? AND id != ?')
    .get(guest.order_id, finalIdNumber, guestId);
  if (existing) throw new Error('同一订单中证件号不能重复');

  let birthDate = guest.birth_date;
  let gender = guest.gender;
  if (finalIdType === 'id_card' && (id_number !== undefined || id_type !== undefined)) {
    const parsed = parseIdCard(finalIdNumber);
    if (parsed) {
      birthDate = parsed.birth_date;
      gender = parsed.gender;
    }
  }

  if (finalIsPrimary) {
    db.prepare('UPDATE guests SET is_primary = 0 WHERE order_id = ? AND id != ?').run(guest.order_id, guestId);
  }

  db.prepare(`
    UPDATE guests SET
      name = ?, id_type = ?, id_number = ?, phone = ?, is_primary = ?,
      birth_date = ?, gender = ?, updated_at = datetime('now', 'localtime')
    WHERE id = ?
  `).run(finalName, finalIdType, finalIdNumber, finalPhone, finalIsPrimary, birthDate, gender, guestId);

  const capacityCheck = checkGuestCapacity(guest.order_id);
  if (capacityCheck.is_over) {
    throw new Error(`入住人数(${capacityCheck.guest_count})超过房源最大容量(${capacityCheck.capacity})，超员${capacityCheck.over_count}人`);
  }

  const collisions = checkIdCollision(guest.order_id, finalIdNumber, order.check_in, order.check_out);
  const result = { updated: true, collisions };

  const capacityAfter = checkGuestCapacity(guest.order_id);
  result.capacity = capacityAfter;

  return result;
}

function deleteGuest(guestId) {
  const guest = db.prepare('SELECT * FROM guests WHERE id = ?').get(guestId);
  if (!guest) throw new Error('入住人不存在');

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(guest.order_id);
  if (!order) throw new Error('订单不存在');
  if (!canModifyGuests(order)) throw new Error('当前订单状态不能修改入住人');

  db.prepare('DELETE FROM guests WHERE id = ?').run(guestId);

  const capacityAfter = checkGuestCapacity(guest.order_id);
  return { deleted: true, capacity: capacityAfter };
}

function getGuests(orderId, mask = true) {
  const guests = db.prepare('SELECT * FROM guests WHERE order_id = ? ORDER BY is_primary DESC, id').all(orderId);
  if (mask) {
    return guests.map(g => ({
      ...g,
      id_number: maskIdNumber(g.id_number, g.id_type)
    }));
  }
  return guests;
}

function getGuestFullIdNumber(guestId) {
  const guest = db.prepare('SELECT * FROM guests WHERE id = ?').get(guestId);
  if (!guest) throw new Error('入住人不存在');
  return { id_number: guest.id_number };
}

function getOrderGuestSummary(orderId) {
  const order = db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId);
  const guests = getGuests(orderId, true);
  const capacity = checkGuestCapacity(orderId);
  return {
    guests,
    guest_count: capacity.guest_count,
    capacity: capacity.capacity,
    is_over: capacity.is_over,
    over_count: capacity.over_count,
    primary_guest: guests.find(g => g.is_primary) || null,
    status: order ? order.status : null
  };
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
  validateIdCardChecksum,
  parseIdCard,
  maskIdNumber,
  validateIdNumber,
  checkIdCollision,
  checkGuestCapacity,
  canModifyGuests,
  addGuest,
  updateGuest,
  deleteGuest,
  getGuests,
  getGuestFullIdNumber,
  getOrderGuestSummary,
};
