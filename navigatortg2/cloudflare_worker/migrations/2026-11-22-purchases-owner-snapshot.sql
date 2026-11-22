-- Снимок владельца папки и параметров продажи на момент оплаты.
-- Нужен для будущей партнёрской программы: продажа остаётся привязанной
-- к владельцу и папке, даже если папку переименуют, перенесут или удалят.
--
-- Заполняется кодом nav-api-v2 (lib/shop.js, recordPurchase). Для старых
-- покупок значения восстанавливаются бэкфиллом и помечаются owner_backfilled = 1.
--
-- Применять: wrangler d1 execute nav-db --remote --file=cloudflare_worker/migrations/2026-11-22-purchases-owner-snapshot.sql

ALTER TABLE purchases ADD COLUMN owner_tg_id TEXT DEFAULT '';
ALTER TABLE purchases ADD COLUMN owner_username TEXT DEFAULT '';
ALTER TABLE purchases ADD COLUMN folder_name TEXT DEFAULT '';
ALTER TABLE purchases ADD COLUMN folder_path TEXT DEFAULT '';
ALTER TABLE purchases ADD COLUMN price_stars INTEGER DEFAULT 0;
ALTER TABLE purchases ADD COLUMN owner_snapshot_ts INTEGER DEFAULT 0;
ALTER TABLE purchases ADD COLUMN owner_backfilled INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_purchases_owner_ts ON purchases (owner_tg_id, ts);
