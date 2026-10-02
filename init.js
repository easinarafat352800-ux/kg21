const path = require('path');
const bcrypt = require('bcryptjs');
// Node's built-in SQLite (no native compile needed). Requires Node 22.13+ (Node 24 works too).
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(path.join(__dirname, 'kg.sqlite'));
module.exports = db; // আগেভাগে সেট: শুরুর মাইগ্রেশনের সময় utils/archive.js এই মডিউল require করলেও যেন সঠিক db পায়
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS admin (
  id TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS super_admin (
  id TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS exam (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT DEFAULT '',
  date TEXT DEFAULT '',
  year TEXT DEFAULT '',
  locked INTEGER DEFAULT 0,
  round INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS institutions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  center TEXT DEFAULT '',
  status TEXT DEFAULT 'draft', -- draft | submitted | confirmed | submitted_pending_redo
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inst_id TEXT NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  father TEXT DEFAULT '',
  mother TEXT DEFAULT '',
  cls TEXT NOT NULL,
  dob TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  photo TEXT DEFAULT '',
  roll TEXT DEFAULT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS gallery (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file TEXT NOT NULL,
  caption TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS roll_counters (
  inst_id TEXT NOT NULL,
  cls TEXT NOT NULL,
  count INTEGER DEFAULT 0,
  PRIMARY KEY (inst_id, cls)
);

-- প্রতিটি শ্রেণির (স্বাভাবিকীকৃত নাম) জন্য একটি অদ্বিতীয় কোড — রোল নম্বরের মাঝের অংশ
CREATE TABLE IF NOT EXISTS class_codes (
  key TEXT PRIMARY KEY,
  code INTEGER NOT NULL UNIQUE,
  label TEXT DEFAULT ''
);

-- একাধিক পরীক্ষা: এডমিন যে পরীক্ষা যুক্ত করে (এক্টিভ করে) সেটাই এখানে থাকে ও সব প্রতিষ্ঠানে দেখায়
CREATE TABLE IF NOT EXISTS exams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '',
  date TEXT DEFAULT '',
  year TEXT DEFAULT '',
  locked INTEGER DEFAULT 0, -- রোল জেনারেট হয়ে গেলে 1
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- প্রতিটি (প্রতিষ্ঠান, পরীক্ষা) জোড়ার আলাদা কেন্দ্র ও স্ট্যাটাস
CREATE TABLE IF NOT EXISTS inst_exam (
  inst_id TEXT NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  center TEXT DEFAULT '',
  status TEXT DEFAULT 'draft', -- draft | submitted | confirmed
  PRIMARY KEY (inst_id, exam_id)
);

-- রোলের ক্রমিক কাউন্টার: প্রতিটি পরীক্ষায় প্রতিষ্ঠান ও শ্রেণিভেদে আলাদা (১ থেকে শুরু)
CREATE TABLE IF NOT EXISTS exam_roll_counters (
  exam_id INTEGER NOT NULL,
  inst_id TEXT NOT NULL,
  cls TEXT NOT NULL,
  count INTEGER DEFAULT 0,
  PRIMARY KEY (exam_id, inst_id, cls)
);
`);

// ---------------------------------------------------------------
// মাইগ্রেশন (পুরনো ডেটাবেসেও নিরাপদে চলে; নতুন ডেটাবেসে কিছুই নষ্ট করে না)
// ---------------------------------------------------------------
function hasCol(table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
}

// প্রতিষ্ঠানের অদ্বিতীয় সংখ্যাসূচক কোড (রোল নম্বরের প্রথম অংশ)
if (!hasCol('institutions', 'code')) db.exec('ALTER TABLE institutions ADD COLUMN code INTEGER');
{
  const missing = db.prepare('SELECT id FROM institutions WHERE code IS NULL ORDER BY created_at ASC, rowid ASC').all();
  if (missing.length) {
    let max = db.prepare('SELECT COALESCE(MAX(code), 0) m FROM institutions').get().m;
    const upd = db.prepare('UPDATE institutions SET code = ? WHERE id = ?');
    missing.forEach(r => upd.run(++max, r.id));
    db.prepare(`INSERT INTO settings (key, value) VALUES ('inst_code_seq', ?)
      ON CONFLICT(key) DO UPDATE SET value = MAX(CAST(value AS INTEGER), CAST(excluded.value AS INTEGER))`).run(String(max));
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_inst_code ON institutions(code)');
}

// প্রতিষ্ঠানের EIIN (এডমিন নিজে দেয়) — রোল নম্বরের প্রথম অংশ। TEXT, যাতে শুরুর শূন্য হারায় না
if (!hasCol('institutions', 'eiin')) db.exec('ALTER TABLE institutions ADD COLUMN eiin TEXT');
// পুরনো প্রতিষ্ঠানগুলোর আগের কোডই EIIN ঘরে বসে (৩ অঙ্কে), যাতে আগে দেওয়া রোলের সাথে মিল থাকে; এডমিন পরে বদলাতে পারবে
db.exec(`UPDATE institutions SET eiin = printf('%03d', code) WHERE eiin IS NULL AND code IS NOT NULL`);
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_inst_eiin ON institutions(eiin)');

// ল্যান্ডিং পেজ: গ্যালারির ধরন (slider = উপরের স্লাইডার, photo = ফটো গ্যালারী), বিস্তারিত; নোটিশের ধরন (notice | result)
if (!hasCol('gallery', 'kind')) db.exec("ALTER TABLE gallery ADD COLUMN kind TEXT DEFAULT 'slider'");
if (!hasCol('gallery', 'details')) db.exec("ALTER TABLE gallery ADD COLUMN details TEXT DEFAULT ''");
if (!hasCol('notices', 'kind')) db.exec("ALTER TABLE notices ADD COLUMN kind TEXT DEFAULT 'notice'");
// নোটিশের সাথে ঐচ্ছিক পিডিএফ (শিরোনামে ক্লিক করলে এটি খোলে)
if (!hasCol('notices', 'pdf_path')) db.exec("ALTER TABLE notices ADD COLUMN pdf_path TEXT DEFAULT ''");

// মেরিট লিস্ট: এডমিনের আপলোড করা PDF/Excel/Word/ছবি থেকে স্বয়ংক্রিয়ভাবে তৈরি হওয়া নম্বর-অনুসারে (বেশি থেকে কম) সাজানো তালিকা
db.exec(`
CREATE TABLE IF NOT EXISTS merit_lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT DEFAULT '',
  source_file TEXT DEFAULT '',
  source_name TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS merit_list_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  list_id INTEGER NOT NULL REFERENCES merit_lists(id) ON DELETE CASCADE,
  rnk INTEGER NOT NULL,
  name TEXT NOT NULL,
  marks REAL,
  roll TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_mli_list ON merit_list_items(list_id);
`);

// স্বতন্ত্র (সুপার এডমিনের যোগ করা) শিক্ষার্থী চিহ্নিত করার ফ্ল্যাগ
if (!hasCol('students', 'is_independent')) db.exec('ALTER TABLE students ADD COLUMN is_independent INTEGER DEFAULT 0');

// শিক্ষার্থী কোন পরীক্ষার — এই কলাম দিয়েই পরীক্ষা মুছলে তার শিক্ষার্থীরা মোছা হয়
if (!hasCol('students', 'exam_id')) db.exec('ALTER TABLE students ADD COLUMN exam_id INTEGER');

// ---- আগের (একক পরীক্ষার) ডেটা নতুন কাঠামোয় সরানো — একবারই চলে, কিছু হারায় না ----
{
  const done = db.prepare(`SELECT value FROM settings WHERE key = 'multi_exam_migrated'`).get();
  if (!done) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const legacy = db.prepare('SELECT * FROM exam WHERE id = 1').get();
      const stuCount = db.prepare('SELECT COUNT(*) c FROM students').get().c;
      if (legacy && (legacy.name || legacy.date || stuCount > 0)) {
        db.prepare('INSERT INTO exams (id, name, date, year, locked) VALUES (1, ?, ?, ?, ?)')
          .run(legacy.name || 'পূর্বের পরীক্ষা', legacy.date || '', legacy.year || '', legacy.locked ? 1 : 0);
        db.exec('UPDATE students SET exam_id = 1 WHERE exam_id IS NULL');
        // আগে "Re-submit প্রয়োজন" স্ট্যাটাস ছিল — রোল অপরিবর্তিত ছিল, তাই এখন সরাসরি Confirmed ধরা হলো
        db.exec(`INSERT OR IGNORE INTO inst_exam (inst_id, exam_id, center, status)
          SELECT id, 1, COALESCE(center, ''), CASE WHEN status = 'submitted_pending_redo' THEN 'confirmed' ELSE COALESCE(status, 'draft') END
          FROM institutions`);
        db.exec(`INSERT OR IGNORE INTO exam_roll_counters (exam_id, inst_id, cls, count)
          SELECT 1, inst_id, cls, count FROM roll_counters`);
      }
      db.prepare(`INSERT INTO settings (key, value) VALUES ('multi_exam_migrated', '1')
        ON CONFLICT(key) DO UPDATE SET value = '1'`).run();
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

// ---------------------------------------------------------------
// শিক্ষার্থী আর্কাইভ: প্রতিষ্ঠান বা পরীক্ষা মুছে গেলেও এখানে শিক্ষার্থীর সব তথ্য (ছবিসহ) থেকে যায়।
// এডমিনের "শিক্ষার্থী খুজুন" এবং ল্যান্ডিং পেজের সংখ্যা/খোঁজা এই টেবিল থেকেই চলে।
// person_key = নাম + পিতার নাম + জন্মতারিখ (স্বাভাবিকীকৃত) — একই শিক্ষার্থী একাধিক পরীক্ষা/সালে এলে একজন ধরা হয়।
// ---------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS student_archive (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER UNIQUE,            -- চালু শিক্ষার্থী সারির id (শিক্ষার্থী/পরীক্ষা মুছলে NULL হয়, আর্কাইভ থাকে)
  person_key TEXT NOT NULL,
  name TEXT NOT NULL,
  father TEXT DEFAULT '',
  mother TEXT DEFAULT '',
  cls TEXT DEFAULT '',
  dob TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  photo TEXT DEFAULT '',
  roll TEXT DEFAULT NULL,
  inst_id TEXT DEFAULT '',
  inst_name TEXT DEFAULT '',
  eiin TEXT DEFAULT '',
  exam_id INTEGER,
  exam_name TEXT DEFAULT '',
  exam_date TEXT DEFAULT '',
  year TEXT DEFAULT '',
  year_key TEXT DEFAULT '',
  is_independent INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_arch_person ON student_archive(person_key);
CREATE INDEX IF NOT EXISTS idx_arch_year ON student_archive(year_key);
CREATE INDEX IF NOT EXISTS idx_arch_exam ON student_archive(exam_id);
`);

// ডেটাবেস স্তরেই গ্যারান্টি: একই পরীক্ষায় একই রোল দুইজনের হতে পারবে না
// (পরীক্ষা আলাদা হলে ক্রমিক আবার ১ থেকে শুরু হয়, তাই আগের "শুধু রোল" ইউনিক ইনডেক্স সরানো হলো)
db.exec('DROP INDEX IF EXISTS idx_students_roll');
try {
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_students_exam_roll ON students(exam_id, roll) WHERE roll IS NOT NULL');
} catch (e) {
  const dups = db.prepare('SELECT roll, COUNT(*) c FROM students WHERE roll IS NOT NULL GROUP BY exam_id, roll HAVING c > 1').all();
  console.warn('[warn] আগের ডেটায় ডুপ্লিকেট রোল আছে, তাই রোলের ইউনিক ইনডেক্স বসানো যায়নি:', dups.map(d => d.roll).join(', '));
}

// seed admin from .env, only on first run
function seedAdmin() {
  const existing = db.prepare('SELECT * FROM admin').get();
  if (existing) return;
  const id = process.env.ADMIN_ID || 'admin';
  const pw = process.env.ADMIN_PASSWORD || 'admin123';
  const hash = bcrypt.hashSync(pw, 10);
  db.prepare('INSERT INTO admin (id, password_hash) VALUES (?, ?)').run(id, hash);
  console.log(`[seed] Admin account created: ${id} (password from .env)`);
}
seedAdmin();

function seedSuperAdmin() {
  const existing = db.prepare('SELECT * FROM super_admin').get();
  if (existing) return;
  const id = process.env.SUPER_ADMIN_ID || 'superadmin';
  const pw = process.env.SUPER_ADMIN_PASSWORD || 'super123';
  db.prepare('INSERT INTO super_admin (id, password_hash) VALUES (?, ?)').run(id, bcrypt.hashSync(pw, 10));
  console.log(`[seed] Super Admin account created: ${id}`);
  if (!process.env.SUPER_ADMIN_PASSWORD) {
    console.warn('[warn] SUPER_ADMIN_PASSWORD .env-এ দেওয়া হয়নি — ডিফল্ট "super123" ব্যবহার হয়েছে। এখনই পরিবর্তন করুন!');
  }
}
seedSuperAdmin();

// আগে থেকে থাকা শিক্ষার্থীদের আর্কাইভে তোলা — একবারই চলে (require চক্র এড়াতে আর্কাইভ মডিউল এখানে লোড হয়)
{
  const done = db.prepare(`SELECT value FROM settings WHERE key = 'archive_backfilled'`).get();
  if (!done) {
    require('../utils/archive').backfillArchive(db);
    db.prepare(`INSERT INTO settings (key, value) VALUES ('archive_backfilled', '1')
      ON CONFLICT(key) DO UPDATE SET value = '1'`).run();
  }
}

module.exports = db;
