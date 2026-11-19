-- Корневая папка владельца: одна на Telegram-аккаунт.
-- Существующая первая папка верхнего уровня становится корневой, остальные
-- верхнеуровневые папки и маршруты без папки переносятся внутрь неё.

CREATE TABLE IF NOT EXISTS owner_roots (
  owner_tg_id TEXT PRIMARY KEY,
  folder_id   INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_owner_roots_folder ON owner_roots (folder_id);

INSERT OR IGNORE INTO owner_roots (owner_tg_id, folder_id, created_at)
SELECT owner_tg_id, MIN(id), CAST(strftime('%s', 'now') AS INTEGER) * 1000
  FROM folders
 WHERE parent_id IS NULL OR parent_id = ''
 GROUP BY owner_tg_id;

UPDATE folders
   SET parent_id = (SELECT folder_id FROM owner_roots r WHERE r.owner_tg_id = folders.owner_tg_id)
 WHERE (parent_id IS NULL OR parent_id = '')
   AND id <> (SELECT folder_id FROM owner_roots r WHERE r.owner_tg_id = folders.owner_tg_id);

UPDATE roads
   SET folder_id = (SELECT folder_id FROM owner_roots r WHERE r.owner_tg_id = roads.owner_tg_id)
 WHERE (folder_id IS NULL OR folder_id = '')
   AND owner_tg_id IN (SELECT owner_tg_id FROM owner_roots);
