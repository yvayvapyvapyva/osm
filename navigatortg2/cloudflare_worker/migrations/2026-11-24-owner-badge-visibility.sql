-- Видимость бейджа владельца на корневой папке в навигаторе.
-- 1 — показывать имя/аватар/username, 0 — скрыть для анонимности.
ALTER TABLE owner_roots ADD COLUMN show_badge INTEGER DEFAULT 1;
