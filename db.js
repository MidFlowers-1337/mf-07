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
    if (isWeekend(night)) {
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
    SELECT id, guest_name, check_in, check_out, status
    FROM orders
    WHERE room_id = ?
      AND status NOT IN ('cancelled')
      AND check_in < ?
      AND check_out > ?
  `;
  const params = [roomId, checkOut, checkIn];
  if (excludeOrderId) {
    sql += ' AND id != ?';
    params.push(excludeOrderId);
  }
  const stmt = db.prepare(sql);
  return stmt.all(...params);
}

module.exports = {
  db,
  initDb,
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
};
