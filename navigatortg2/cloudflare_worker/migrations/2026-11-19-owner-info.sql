-- Свободная информация владельца (показывается в окне владельца в навигаторе).
ALTER TABLE owner_roots ADD COLUMN owner_info TEXT DEFAULT '';
