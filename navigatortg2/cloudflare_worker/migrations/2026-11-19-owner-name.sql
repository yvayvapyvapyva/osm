-- Имя владельца корневой папки для подписи в навигаторе.
ALTER TABLE owner_roots ADD COLUMN owner_name TEXT DEFAULT '';

-- Для существующих владельцев берём имя из автора первого маршрута
-- (без служебного суффикса «(vk: ...)»/«(tg: ...)»).
UPDATE owner_roots
   SET owner_name = COALESCE((
        SELECT CASE
                 WHEN INSTR(creator_name, ' (') > 0
                   THEN SUBSTR(creator_name, 1, INSTR(creator_name, ' (') - 1)
                 ELSE creator_name
               END
          FROM roads
         WHERE roads.owner_tg_id = owner_roots.owner_tg_id
           AND creator_name IS NOT NULL AND creator_name <> ''
         ORDER BY m
         LIMIT 1
   ), '')
 WHERE owner_name IS NULL OR owner_name = '';
