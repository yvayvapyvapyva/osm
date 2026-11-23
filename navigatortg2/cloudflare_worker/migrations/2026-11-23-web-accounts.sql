-- Веб-версия навигатора: отдельные покупатели по email.
-- Telegram-пользователи и покупки Stars не меняются.
--
-- Применять: wrangler d1 execute nav-db --remote --file=cloudflare_worker/migrations/2026-11-23-web-accounts.sql

CREATE TABLE IF NOT EXISTS web_accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  email_verified_at INTEGER,
  consent_at INTEGER,
  consent_version TEXT,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS web_sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  ip TEXT DEFAULT '',
  user_agent TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS web_email_tokens (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'login',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  ip TEXT DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_web_sessions_account ON web_sessions (account_id);
CREATE INDEX IF NOT EXISTS idx_web_email_tokens_email ON web_email_tokens (email, created_at);

ALTER TABLE purchases ADD COLUMN account_id TEXT DEFAULT '';
ALTER TABLE purchases ADD COLUMN provider TEXT DEFAULT 'stars';
