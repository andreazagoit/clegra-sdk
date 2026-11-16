-- What the app keeps for a workspace host's installation beyond its warehouse: the state the host last told it
-- (`clegra_installation`), the low-stock alerts already sent (the `low_stock_check` schedule tells people once per
-- product until it is back in stock), and the clegra package's tables as SqlStore.schema() writes them now (its
-- second table holds later runs; the lifecycle's delete clears a tenant's there). A test keeps this file and the
-- package equal.

CREATE TABLE installation_state (
  tenant_id  text PRIMARY KEY REFERENCES tenant (id) ON DELETE CASCADE,
  state      text NOT NULL CHECK (state IN ('enabled', 'disabled', 'uninstalled')),
  changed_at timestamptz NOT NULL DEFAULT now()
);

-- A product at or under its reorder level that people were told about: deleted when it is back over it.
CREATE TABLE stock_alert (
  tenant_id   text NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  product_id  text NOT NULL REFERENCES product (id) ON DELETE CASCADE,
  notified_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, product_id)
);

CREATE TABLE IF NOT EXISTS clegra_store (key text PRIMARY KEY, args text NOT NULL, result jsonb, done boolean NOT NULL DEFAULT false, expires_at timestamptz NOT NULL);
CREATE INDEX IF NOT EXISTS clegra_store_expires_at ON clegra_store (expires_at);
CREATE TABLE IF NOT EXISTS clegra_store_later (id text PRIMARY KEY, tenant text NOT NULL, tool text NOT NULL, args text NOT NULL, args_hash text NOT NULL, at text NOT NULL, due_at timestamptz NOT NULL, until bigint NOT NULL, author jsonb, permissions jsonb NOT NULL, proof text, issuer text NOT NULL, subject text NOT NULL, installation text NOT NULL, call text, confirmed_at bigint NOT NULL, status text NOT NULL DEFAULT 'pending', message text, created_at timestamptz NOT NULL DEFAULT now(), claimed_at timestamptz, finished_at timestamptz);
CREATE INDEX IF NOT EXISTS clegra_store_later_due ON clegra_store_later (tenant, due_at) WHERE status = 'pending';
