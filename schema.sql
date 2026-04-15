CREATE TABLE IF NOT EXISTS sessions (
    id            TEXT PRIMARY KEY,
    alias         TEXT UNIQUE,
    created_at    TEXT NOT NULL,
    last_activity TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_alias
    ON sessions(alias) WHERE alias IS NOT NULL;

CREATE TABLE IF NOT EXISTS messages (
    id            TEXT PRIMARY KEY,
    sender_id     TEXT NOT NULL,
    recipient_id  TEXT NOT NULL,
    broadcast_id  TEXT,
    content       TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    read_at       TEXT,
    FOREIGN KEY (sender_id)    REFERENCES sessions(id),
    FOREIGN KEY (recipient_id) REFERENCES sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_messages_recipient_unread
    ON messages(recipient_id, read_at) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_messages_broadcast
    ON messages(broadcast_id) WHERE broadcast_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
