-- Привязка маршрутов и папок к Telegram-аккаунту.
-- Выполнять на D1 один раз: wrangler d1 execute nav-db-v2 --remote --file=...
-- (ALTER TABLE ... ADD COLUMN повторно выполнить нельзя — пропустите, если
-- столбцы уже есть.)

ALTER TABLE folders ADD COLUMN owner_tg_id TEXT DEFAULT '';
ALTER TABLE roads ADD COLUMN owner_tg_id TEXT DEFAULT '';

-- Существующие данные закрепляем за владельцем проекта.
UPDATE folders SET owner_tg_id = '7292595756'
 WHERE owner_tg_id IS NULL OR owner_tg_id = '';
UPDATE roads SET owner_tg_id = '7292595756'
 WHERE owner_tg_id IS NULL OR owner_tg_id = '';

CREATE INDEX IF NOT EXISTS idx_folders_owner ON folders (owner_tg_id);
CREATE INDEX IF NOT EXISTS idx_roads_owner ON roads (owner_tg_id);
