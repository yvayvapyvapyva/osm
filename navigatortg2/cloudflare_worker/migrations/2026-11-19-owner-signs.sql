-- Личная сцена дорожных знаков владельца.
-- Одна JSON-сцена на Telegram-аккаунт: редактор сохраняет, навигатор читает
-- её вместе с пакетом корневой папки.

CREATE TABLE IF NOT EXISTS owner_signs (
  owner_tg_id TEXT PRIMARY KEY,
  data        TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
