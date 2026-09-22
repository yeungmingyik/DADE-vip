UPDATE members SET phone = replace(replace(replace(replace(phone, ' ', ''), '-', ''), '(', ''), ')', '');
UPDATE members SET phone = '+65' || phone WHERE length(phone) = 8 AND phone NOT LIKE '+%';
CREATE UNIQUE INDEX IF NOT EXISTS members_phone_unique ON members(phone);
DELETE FROM sessions WHERE role = 'member';
CREATE TABLE member_otp_challenges (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  resend_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  consumed_at TEXT,
  delivered INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX member_otp_phone_time ON member_otp_challenges(phone, created_at);
CREATE TABLE member_registration_tokens (
  token_hash TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX member_registration_phone ON member_registration_tokens(phone);
