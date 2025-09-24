const { pool, isDatabaseConnected } = require('../db/pool');

// Mock data for when database is not available
let mockProducts = [
  {
    id: 1,
    name: 'Sample Product',
    description: 'This is a sample product for demo purposes',
    price: 29.99,
    quantity: 50,
    sku: 'SAMPLE-001',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  },
  {
    id: 2,
    name: 'Demo Item',
    description: 'Another demo item to show the interface',
    price: 15.50,
    quantity: 25,
    sku: 'DEMO-002',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }
];
let nextId = 3;

// Helper function to check if database is available
function isDatabaseAvailable() {
  return isDatabaseConnected();
}

// CREATE
async function insertProduct({ name, description = null, price, quantity, sku }) {
  if (!isDatabaseAvailable()) {
    // Mock implementation - check for duplicate SKU
    const existingSku = mockProducts.find(p => p.sku === sku);
    if (existingSku) {
      const error = new Error('SKU already exists');
      error.code = '23505'; // Simulate PostgreSQL unique violation
      throw error;
    }
    
    const product = {
      id: nextId++,
      name,
      description,
      price: parseFloat(price),
      quantity: parseInt(quantity),
      sku,
      created_at: new Date(),
      updated_at: new Date()
    };
    mockProducts.push(product);
    return product;
  }
  const q = `
    INSERT INTO products (name, description, price, quantity, sku)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *`;
  const v = [name, description, price, quantity, sku];
  const { rows } = await pool.query(q, v);
  return rows[0];
}

// LIST with pagination + optional search on name or sku
async function findProducts({ offset, limit, search }) {
  if (!isDatabaseAvailable()) {
    // Mock implementation
    let filteredProducts = mockProducts;
    
    if (search) {
      const searchLower = search.toLowerCase();
      filteredProducts = mockProducts.filter(p => 
        p.name.toLowerCase().includes(searchLower) || 
        p.sku.toLowerCase().includes(searchLower)
      );
    }
    
    const total = filteredProducts.length;
    const rows = filteredProducts
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(offset, offset + limit);
    
    return { rows, total };
  }
  const params = [];
  const where = [];

  if (search) {
    params.push(`%${search}%`, `%${search}%`);
    where.push(`(name ILIKE $${params.length - 1} OR sku ILIKE $${params.length})`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // data
  params.push(limit, offset);
  const dataSql = `
    SELECT *
    FROM products
    ${whereSql}
    ORDER BY created_at DESC
    LIMIT $${params.length - 1} OFFSET $${params.length};`;

  const dataRes = await pool.query(dataSql, params);
  const rows = dataRes.rows;

  // count (rebuild params for count in the same order)
  const countParams = search ? [`%${search}%`, `%${search}%`] : [];
  const countSql = `SELECT COUNT(*)::int AS count FROM products ${whereSql};`;
  const countRes = await pool.query(countSql, countParams);
  const total = countRes.rows[0].count;

  return { rows, total };
}

// READ by id
async function findById(id) {
  if (!isDatabaseAvailable()) {
    // Mock implementation
    return mockProducts.find(p => p.id === parseInt(id)) || null;
  }
  const { rows } = await pool.query('SELECT * FROM products WHERE id = $1;', [id]);
  return rows[0] || null;
}

// UPDATE (full update)
async function updateProduct(id, { name, description = null, price, quantity, sku }) {
  if (!isDatabaseAvailable()) {
    // Mock implementation
    const productIndex = mockProducts.findIndex(p => p.id === parseInt(id));
    if (productIndex === -1) return null;
    
    mockProducts[productIndex] = {
      ...mockProducts[productIndex],
      name,
      description,
      price: parseFloat(price),
      quantity: parseInt(quantity),
      sku,
      updated_at: new Date()
    };
    
    return mockProducts[productIndex];
  }
  const q = `
    UPDATE products
       SET name = $1,
           description = $2,
           price = $3,
           quantity = $4,
           sku = $5
     WHERE id = $6
     RETURNING *`;
  const v = [name, description, price, quantity, sku, id];
  const { rows } = await pool.query(q, v);
  return rows[0] || null;
}

// DELETE
async function removeProduct(id) {
  if (!isDatabaseAvailable()) {
    // Mock implementation
    const productIndex = mockProducts.findIndex(p => p.id === parseInt(id));
    if (productIndex === -1) return null;
    
    const removed = mockProducts.splice(productIndex, 1)[0];
    return { id: removed.id };
  }
  const { rows } = await pool.query('DELETE FROM products WHERE id = $1 RETURNING id;', [id]);
  return rows[0] || null;
}

module.exports = {
  insertProduct,
  findProducts,
  findById,
  updateProduct,
  removeProduct
};