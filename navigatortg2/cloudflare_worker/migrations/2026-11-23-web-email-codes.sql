-- Одноразовые 6-значные коды для входа в веб-версию.
-- Хранится HMAC-хеш кода, а не сам код.

CREATE TABLE IF NOT EXISTS web_email_codes (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  used_at INTEGER,
  ip TEXT DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_web_email_codes_email
  ON web_email_codes (email, created_at);
