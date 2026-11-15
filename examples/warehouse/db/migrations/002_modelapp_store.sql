-- MAP: idempotency of writes and one-time token ids (SqlStore.schema() of @modelapp/server; a test keeps the two equal).
CREATE TABLE IF NOT EXISTS modelapp_store (key text PRIMARY KEY, args text NOT NULL, result jsonb, done boolean NOT NULL DEFAULT false, expires_at timestamptz NOT NULL);
CREATE INDEX IF NOT EXISTS modelapp_store_expires_at ON modelapp_store (expires_at);
