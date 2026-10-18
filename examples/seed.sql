-- Demo schema for `docker compose --profile demo up` and the integration tests.
CREATE SCHEMA IF NOT EXISTS shop;

CREATE TABLE IF NOT EXISTS shop.customers (
  id         bigserial PRIMARY KEY,
  email      text NOT NULL UNIQUE,
  name       text,
  api_token  text,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE shop.customers IS 'People who bought something';
CREATE INDEX IF NOT EXISTS customers_token_idx ON shop.customers (api_token);

CREATE TABLE IF NOT EXISTS shop.orders (
  id          bigserial PRIMARY KEY,
  customer_id bigint NOT NULL REFERENCES shop.customers(id),
  total_cents integer NOT NULL CHECK (total_cents >= 0),
  status      text NOT NULL DEFAULT 'pending',
  placed_on   date NOT NULL DEFAULT current_date,
  meta        jsonb
);
CREATE INDEX IF NOT EXISTS orders_customer_idx ON shop.orders (customer_id);

CREATE OR REPLACE VIEW shop.order_totals AS
  SELECT c.email, count(o.id) AS orders, coalesce(sum(o.total_cents), 0) AS total_cents
  FROM shop.customers c LEFT JOIN shop.orders o ON o.customer_id = c.id
  GROUP BY c.email;

INSERT INTO shop.customers (email, name, api_token, created_at) VALUES
  ('ada@example.com', 'Ada', 'tok_ada_secret', '2024-01-02 03:04:05+00'),
  ('linus@example.com', 'Linus', 'tok_linus_secret', '2024-02-03 04:05:06+00')
ON CONFLICT (email) DO NOTHING;

INSERT INTO shop.orders (customer_id, total_cents, status, placed_on, meta)
SELECT c.id, v.total, v.status, v.placed::date, v.meta::jsonb
FROM (VALUES
  ('ada@example.com', 1200, 'paid', '2024-03-01', '{"coupon":"WELCOME"}'),
  ('ada@example.com', 560, 'pending', '2024-03-05', NULL),
  ('linus@example.com', 9900, 'paid', '2024-03-07', '{"gift":true}')
) AS v(email, total, status, placed, meta)
JOIN shop.customers c ON c.email = v.email
WHERE NOT EXISTS (SELECT 1 FROM shop.orders);

-- Outside the demo allowlist: used to test schemas / hidden_columns policies.
CREATE SCHEMA IF NOT EXISTS secret;
CREATE TABLE IF NOT EXISTS secret.vault (id int PRIMARY KEY, secret text NOT NULL);
INSERT INTO secret.vault VALUES (1, 'launch codes') ON CONFLICT DO NOTHING;
