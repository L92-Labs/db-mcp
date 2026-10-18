-- MySQL demo schema (database `shop`) for `docker compose --profile demo` and integration tests.
CREATE DATABASE IF NOT EXISTS shop;
USE shop;

CREATE TABLE IF NOT EXISTS customers (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  email      VARCHAR(255) NOT NULL UNIQUE,
  name       VARCHAR(255),
  api_token  VARCHAR(255),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX customers_token_idx (api_token)
) COMMENT = 'People who bought something';

CREATE TABLE IF NOT EXISTS orders (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  customer_id BIGINT NOT NULL,
  total_cents INT NOT NULL,
  status      VARCHAR(32) NOT NULL DEFAULT 'pending',
  placed_on   DATE NOT NULL,
  meta        JSON,
  CONSTRAINT orders_customer_fk FOREIGN KEY (customer_id) REFERENCES customers (id),
  INDEX orders_customer_idx (customer_id)
);

CREATE OR REPLACE VIEW order_totals AS
  SELECT c.email, COUNT(o.id) AS orders, COALESCE(SUM(o.total_cents), 0) AS total_cents
  FROM customers c LEFT JOIN orders o ON o.customer_id = c.id
  GROUP BY c.email;

INSERT IGNORE INTO customers (id, email, name, api_token, created_at) VALUES
  (1, 'ada@example.com', 'Ada', 'tok_ada_secret', '2024-01-02 03:04:05'),
  (2, 'linus@example.com', 'Linus', 'tok_linus_secret', '2024-02-03 04:05:06');

INSERT IGNORE INTO orders (id, customer_id, total_cents, status, placed_on, meta) VALUES
  (1, 1, 1200, 'paid', '2024-03-01', '{"coupon": "WELCOME"}'),
  (2, 1, 560, 'pending', '2024-03-05', NULL),
  (3, 2, 9900, 'paid', '2024-03-07', '{"gift": true}');

CREATE DATABASE IF NOT EXISTS secret;
CREATE TABLE IF NOT EXISTS secret.vault (id INT PRIMARY KEY, secret VARCHAR(255) NOT NULL);
INSERT IGNORE INTO secret.vault VALUES (1, 'launch codes');
