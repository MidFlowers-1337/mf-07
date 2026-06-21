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

  const cleanerConflict = checkCleanerConflict(cleanerName, checkOut);
  if (cleanerConflict.length > 0) {
    throw new Error(`清洁阿姨(${cleanerName})${checkOut}已有安排，请换个时间或换个阿姨`);
  }

  const insertOrder = db.prepare(`
    INSERT INTO orders (room_id, guest_name, guest_phone, check_in, check_out, nights, total_price, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed')
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
    const info = insertOrder.run(roomId, guestName, guestPhone || '', checkIn, checkOut, nights, total);
    const orderId = info.lastInsertRowid;

    for (const night of nightsArr) {
      insertDate.run(roomId, night, orderId);
    }

    insertCleaning.run(roomId, orderId, checkOut, cleanerName);

    return orderId;
  })();

  return result;
}

function cancelOrder(orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) throw new Error('订单不存在');
  if (order.status === 'cancelled') throw new Error('订单已取消');

  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(order.room_id);
  const today = dateToStr(new Date());
  const { fee, refund, rule } = calcCancelFee(room, order.check_in, order.check_out, today);

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
    updateOrder.run(fee, refund, orderId);
    deleteDates.run(orderId);
    cancelCleaning.run(orderId);
  })();

  return { fee, refund, rule };
}

module.exports = {
  db,
  initDb,
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
};
