-- Профиль владельца: аватар и username из Telegram.
ALTER TABLE owner_roots ADD COLUMN owner_avatar TEXT DEFAULT '';
ALTER TABLE owner_roots ADD COLUMN owner_username TEXT DEFAULT '';
