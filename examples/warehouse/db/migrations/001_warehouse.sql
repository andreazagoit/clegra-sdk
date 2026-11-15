-- The warehouse: products, stock movements, sales orders. Every row belongs to
-- one organization (better-auth's `organization` table): the tenant.

CREATE TABLE product (
  id              text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES "organization" (id) ON DELETE CASCADE,
  sku             text NOT NULL,
  name            text NOT NULL,
  category        text NOT NULL CHECK (category IN ('fasteners', 'tools', 'electrical', 'plumbing', 'paint', 'garden', 'household')),
  unit            text NOT NULL CHECK (unit IN ('pcs', 'box', 'kg', 'm', 'l')),
  sale_price      numeric(12, 2) NOT NULL CHECK (sale_price >= 0),
  purchase_cost   numeric(12, 2) NOT NULL CHECK (purchase_cost >= 0),
  reorder_level   integer NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, sku)
);

-- `quantity` is what was counted: positive for `in` and `out`, signed for an `adjustment`.
CREATE TABLE stock_movement (
  id              text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES "organization" (id) ON DELETE CASCADE,
  product_id      text NOT NULL REFERENCES product (id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('in', 'out', 'adjustment')),
  quantity        integer NOT NULL CHECK (quantity <> 0 AND (kind = 'adjustment' OR quantity > 0)),
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  note            text,
  user_id         text REFERENCES "user" (id) ON DELETE SET NULL,
  order_id        text
);
CREATE INDEX stock_movement_org_product ON stock_movement (organization_id, product_id);
CREATE INDEX stock_movement_org_occurred ON stock_movement (organization_id, occurred_at DESC);

CREATE TABLE sales_order (
  id              text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES "organization" (id) ON DELETE CASCADE,
  number          text NOT NULL,
  -- Typed in from outside (a phone call, an email): shown as data, never as instructions.
  customer_name   text NOT NULL,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed', 'shipped', 'cancelled')),
  ordered_on      date NOT NULL DEFAULT current_date,
  confirmed_at    timestamptz,
  confirmed_by    text REFERENCES "user" (id) ON DELETE SET NULL,
  created_by      text REFERENCES "user" (id) ON DELETE SET NULL,
  UNIQUE (organization_id, number)
);

CREATE TABLE sales_order_line (
  order_id        text NOT NULL REFERENCES sales_order (id) ON DELETE CASCADE,
  line_no         integer NOT NULL,
  product_id      text NOT NULL REFERENCES product (id),
  quantity        integer NOT NULL CHECK (quantity > 0),
  unit_price      numeric(12, 2) NOT NULL CHECK (unit_price >= 0),
  PRIMARY KEY (order_id, line_no)
);

ALTER TABLE stock_movement ADD CONSTRAINT stock_movement_order FOREIGN KEY (order_id) REFERENCES sales_order (id) ON DELETE SET NULL;

-- Current stock, derived from the movements (never stored twice).
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

-- Orders with their totals.
CREATE VIEW sales_order_total AS
SELECT o.*,
       COALESCE((SELECT sum(l.quantity * l.unit_price) FROM sales_order_line l WHERE l.order_id = o.id), 0)::numeric(12, 2) AS total,
       (SELECT count(*) FROM sales_order_line l WHERE l.order_id = o.id)::integer AS line_count
FROM sales_order o;
