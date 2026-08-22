-- База поездок. Каждая поездка — это журнал операций.
-- Состояние не хранится целиком: клиенты складывают его из операций по порядку seq.
-- Так одновременная запись с пяти телефонов ничего не затирает.

CREATE TABLE IF NOT EXISTS trips (
  id         TEXT PRIMARY KEY,       -- секретный код поездки, он же ключ доступа по ссылке
  created    INTEGER NOT NULL,       -- unix ms
  touched    INTEGER NOT NULL,       -- последняя запись, для уборки старья
  chat_id    TEXT,                   -- чат Telegram, куда бот пишет уведомления (может быть пусто)
  title      TEXT                    -- название поездки, для сообщений бота
);

CREATE TABLE IF NOT EXISTS ops (
  seq      INTEGER PRIMARY KEY AUTOINCREMENT,
  op_id    TEXT NOT NULL UNIQUE,     -- id операции с телефона: защита от дублей при досылке
  trip_id  TEXT NOT NULL,
  kind     TEXT NOT NULL,
  payload  TEXT NOT NULL,            -- JSON
  author   TEXT,                     -- имя автора (из Telegram или выбранное в приложении)
  ts       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ops_trip_seq ON ops(trip_id, seq);
