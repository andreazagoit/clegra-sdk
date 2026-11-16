-- Tenants of two kinds: a better-auth organization (the app's own users) or a workspace host's installation
-- (`<installation>@<issuer>`, e.g. a Clegra node). Every data row now belongs to a `tenant`; who registered or
-- confirmed something is a person id of that tenant (a better-auth user, or a host's person, named in `person`).
-- Renames can't be written "IF NOT EXISTS": lib/migrate.ts runs the file once, in one transaction with its journal row.

CREATE TABLE tenant (
  id              text PRIMARY KEY,
  kind            text NOT NULL CHECK (kind IN ('organization', 'workspace')),
  -- An organization's tenant is the organization itself (same id): deleting the organization deletes its data.
  organization_id text UNIQUE REFERENCES "organization" (id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'organization' AND organization_id = id) OR (kind = 'workspace' AND organization_id IS NULL AND position('@' in id) > 0))
);
INSERT INTO tenant (id, kind, organization_id) SELECT id, 'organization', id FROM "organization";

-- Names of the people a workspace host signed in (better-auth users are named from "user").
CREATE TABLE person (
  tenant_id text NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  id        text NOT NULL,
  name      text NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

-- The views list the tables' columns as they were when created: dropped here, created again below.
DROP VIEW product_stock;
DROP VIEW sales_order_total;

ALTER TABLE product DROP CONSTRAINT product_organization_id_fkey;
ALTER TABLE product RENAME COLUMN organization_id TO tenant_id;
ALTER TABLE product RENAME CONSTRAINT product_organization_id_sku_key TO product_tenant_id_sku_key;
ALTER TABLE product ADD CONSTRAINT product_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenant (id) ON DELETE CASCADE;

ALTER TABLE stock_movement DROP CONSTRAINT stock_movement_organization_id_fkey;
ALTER TABLE stock_movement DROP CONSTRAINT stock_movement_user_id_fkey;
ALTER TABLE stock_movement RENAME COLUMN organization_id TO tenant_id;
ALTER TABLE stock_movement RENAME COLUMN user_id TO person_id;
ALTER TABLE stock_movement ADD CONSTRAINT stock_movement_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenant (id) ON DELETE CASCADE;

ALTER TABLE sales_order DROP CONSTRAINT sales_order_organization_id_fkey;
ALTER TABLE sales_order DROP CONSTRAINT sales_order_confirmed_by_fkey;
ALTER TABLE sales_order DROP CONSTRAINT sales_order_created_by_fkey;
ALTER TABLE sales_order RENAME COLUMN organization_id TO tenant_id;
ALTER TABLE sales_order RENAME CONSTRAINT sales_order_organization_id_number_key TO sales_order_tenant_id_number_key;
ALTER TABLE sales_order ADD CONSTRAINT sales_order_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenant (id) ON DELETE CASCADE;

-- A line keeps its product, but deleting a whole tenant deletes both its products and its orders (with their
-- lines): checked at the end of the statement's transaction, so the order of those cascades doesn't matter.
ALTER TABLE sales_order_line DROP CONSTRAINT sales_order_line_product_id_fkey;
ALTER TABLE sales_order_line ADD CONSTRAINT sales_order_line_product_id_fkey FOREIGN KEY (product_id) REFERENCES product (id) DEFERRABLE INITIALLY DEFERRED;

CREATE VIEW product_stock AS
SELECT p.*,
       s.stock,
       CASE WHEN s.stock <= 0 THEN 'out' WHEN s.stock <= p.reorder_level THEN 'low' ELSE 'ok' END AS stock_status
FROM product p
CROSS JOIN LATERAL (
  SELECT COALESCE(sum(CASE WHEN m.kind = 'out' THEN -m.quantity ELSE m.quantity END), 0)::integer AS stock
  FROM stock_movement m
  WHERE m.product_id = p.id
) s;

CREATE VIEW sales_order_total AS
SELECT o.*,
       COALESCE((SELECT sum(l.quantity * l.unit_price) FROM sales_order_line l WHERE l.order_id = o.id), 0)::numeric(12, 2) AS total,
       (SELECT count(*) FROM sales_order_line l WHERE l.order_id = o.id)::integer AS line_count
FROM sales_order o;
