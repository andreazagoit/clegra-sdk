-- MAP kinds: a product's GTIN (EAN/UPC barcode digits), the key by which other apps find the same product.
-- The demo data use the restricted-circulation range (prefix 20–29): numbers no real product carries.
ALTER TABLE product ADD COLUMN gtin text CHECK (gtin ~ '^([0-9]{8}|[0-9]{12,14})$');
CREATE INDEX product_org_gtin ON product (organization_id, gtin);

-- The view lists p.* as it was when it was created: created again, with the new column.
DROP VIEW product_stock;
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
