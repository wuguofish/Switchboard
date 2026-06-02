CREATE TABLE IF NOT EXISTS sessions (
    id            TEXT PRIMARY KEY,
    alias         TEXT,
    cc_session_id TEXT,
    created_at    TEXT NOT NULL,
    last_activity TEXT NOT NULL,
    released_at   TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_alias_active
    ON sessions(alias)
    WHERE alias IS NOT NULL AND released_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_cc_session_id_active
    ON sessions(cc_session_id)
    WHERE cc_session_id IS NOT NULL AND released_at IS NULL;

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
