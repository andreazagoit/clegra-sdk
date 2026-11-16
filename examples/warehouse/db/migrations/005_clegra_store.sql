-- The store took the package's new name: 002's table renamed, with what it holds, then the table as the clegra package's
-- SqlStore.schema() writes it (a no-op after the rename; a test keeps this file and the package equal).
ALTER TABLE IF EXISTS modelapp_store RENAME TO clegra_store;
ALTER INDEX IF EXISTS modelapp_store_expires_at RENAME TO clegra_store_expires_at;
CREATE TABLE IF NOT EXISTS clegra_store (key text PRIMARY KEY, args text NOT NULL, result jsonb, done boolean NOT NULL DEFAULT false, expires_at timestamptz NOT NULL);
CREATE INDEX IF NOT EXISTS clegra_store_expires_at ON clegra_store (expires_at);
