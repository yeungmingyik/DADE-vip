CREATE TABLE IF NOT EXISTS stores (
  id TEXT PRIMARY KEY,
  name_en TEXT NOT NULL,
  name_zh TEXT NOT NULL,
  address TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'inactive'))
);
CREATE TABLE IF NOT EXISTS staff (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('cashier', 'supervisor')),
  store_ids TEXT NOT NULL,
  active INTEGER NOT NULL CHECK (active IN (0, 1))
);
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended')),
  points INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS rules (
  version INTEGER PRIMARY KEY,
  threshold_cents INTEGER NOT NULL CHECK (threshold_cents > 0),
  silver_visits INTEGER NOT NULL CHECK (silver_visits > 0),
  gold_visits INTEGER NOT NULL CHECK (gold_visits > silver_visits),
  monthly_limit INTEGER NOT NULL CHECK (monthly_limit > 0),
  effective_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS gifts (
  id TEXT PRIMARY KEY,
  name_en TEXT NOT NULL,
  name_zh TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('tools', 'lifestyle', 'care')),
  points INTEGER NOT NULL CHECK (points > 0),
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  image TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS gift_stock (
  gift_id TEXT NOT NULL REFERENCES gifts(id),
  store_id TEXT NOT NULL REFERENCES stores(id),
  quantity INTEGER NOT NULL CHECK (quantity >= 0),
  PRIMARY KEY (gift_id, store_id)
);
CREATE TABLE IF NOT EXISTS purchases (
  id TEXT PRIMARY KEY,
  receipt TEXT NOT NULL,
  member_id TEXT NOT NULL REFERENCES members(id),
  store_id TEXT NOT NULL REFERENCES stores(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  refunded_cents INTEGER NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0 AND refunded_cents <= amount_cents),
  points INTEGER NOT NULL CHECK (points IN (0, 1)),
  rule_version INTEGER NOT NULL REFERENCES rules(version),
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  business_day TEXT NOT NULL,
  UNIQUE (store_id, receipt)
);
CREATE TABLE IF NOT EXISTS refunds (
  id TEXT PRIMARY KEY,
  purchase_id TEXT NOT NULL REFERENCES purchases(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  points INTEGER NOT NULL,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS redemptions (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id),
  store_id TEXT NOT NULL REFERENCES stores(id),
  gift_id TEXT NOT NULL REFERENCES gifts(id),
  gift_name_en TEXT NOT NULL,
  gift_name_zh TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  points INTEGER NOT NULL CHECK (points > 0),
  status TEXT NOT NULL CHECK (status IN ('confirmed', 'fulfilled', 'cancelled')),
  actor TEXT NOT NULL,
  rule_version INTEGER NOT NULL REFERENCES rules(version),
  business_month TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS activity (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  member_id TEXT NOT NULL REFERENCES members(id),
  reference_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  points_delta INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  amount_cents INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  store_id TEXT,
  details TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS idempotency (
  actor TEXT NOT NULL,
  request_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (actor, request_id)
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('member', 'staff', 'admin')),
  user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS purchases_member_date ON purchases(member_id, created_at);
CREATE INDEX IF NOT EXISTS purchases_store_date ON purchases(store_id, created_at);
CREATE INDEX IF NOT EXISTS redemptions_member_month ON redemptions(member_id, business_month, status);
CREATE INDEX IF NOT EXISTS redemptions_store_date ON redemptions(store_id, created_at);
CREATE INDEX IF NOT EXISTS activity_member_sequence ON activity(member_id, sequence);
CREATE INDEX IF NOT EXISTS activity_store_sequence ON activity(store_id, sequence);
