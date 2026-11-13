CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL CHECK (length(name) <= 100),
  description TEXT CHECK (length(description) <= 500),
  price REAL NOT NULL CHECK (price >= 0),
  quantity INTEGER NOT NULL CHECK (quantity >= 0),
  sku TEXT NOT NULL UNIQUE CHECK (length(sku) <= 50),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT OR IGNORE INTO products (name, description, price, quantity, sku) VALUES
  ('Sample Product', 'This is a sample product for demo purposes', 29.99, 50, 'SAMPLE-001'),
  ('Demo Item', 'Another demo item to show the interface', 15.50, 25, 'DEMO-002');
