-- The app's roles for people of Clegra companies (who may do what in the warehouse, per pairwise person per tenant):
-- the clegra package's tables as SqlStore.schema() writes them now (its third table holds the roles; the first two are
-- already here from 006 and are left as they are). A test keeps this file and the package equal.

CREATE TABLE IF NOT EXISTS clegra_store (key text PRIMARY KEY, args text NOT NULL, result jsonb, done boolean NOT NULL DEFAULT false, expires_at timestamptz NOT NULL);
CREATE INDEX IF NOT EXISTS clegra_store_expires_at ON clegra_store (expires_at);
CREATE TABLE IF NOT EXISTS clegra_store_later (id text PRIMARY KEY, tenant text NOT NULL, tool text NOT NULL, args text NOT NULL, args_hash text NOT NULL, at text NOT NULL, due_at timestamptz NOT NULL, until bigint NOT NULL, author jsonb, permissions jsonb NOT NULL, proof text, issuer text NOT NULL, subject text NOT NULL, installation text NOT NULL, call text, confirmed_at bigint NOT NULL, status text NOT NULL DEFAULT 'pending', message text, created_at timestamptz NOT NULL DEFAULT now(), claimed_at timestamptz, finished_at timestamptz);
CREATE INDEX IF NOT EXISTS clegra_store_later_due ON clegra_store_later (tenant, due_at) WHERE status = 'pending';
CREATE TABLE IF NOT EXISTS clegra_store_roles (tenant text NOT NULL, sub text NOT NULL, admin boolean NOT NULL DEFAULT false, permissions jsonb NOT NULL DEFAULT '[]'::jsonb, name text, email text, company_role text, seen_at timestamptz, assigned boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant, sub));
