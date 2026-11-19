-- Просмотренные пользователем маршруты: сохраняется между сессиями.
CREATE TABLE IF NOT EXISTS route_views (
  user_id         TEXT NOT NULL,
  m               TEXT NOT NULL,
  first_viewed_at INTEGER NOT NULL,
  last_viewed_at  INTEGER NOT NULL,
  view_count      INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, m)
);
CREATE INDEX IF NOT EXISTS idx_route_views_user ON route_views (user_id);
