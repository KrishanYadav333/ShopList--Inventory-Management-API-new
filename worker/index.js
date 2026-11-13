const MAX_PRODUCTS = 500; // demo cap: writes are public

const json = (body, status = 200) => Response.json(body, { status });
const fail = (status, error, message) => json({ error, message }, status);

function validate(p) {
  const errors = [];
  const str = (v) => typeof v === 'string';
  if (!str(p.name) || !p.name.trim()) errors.push('name is required');
  else if (p.name.length > 100) errors.push('name must be ≤ 100 chars');
  if (p.description != null && (!str(p.description) || p.description.length > 500))
    errors.push('description must be a string ≤ 500 chars');
  if (typeof p.price !== 'number' || Number.isNaN(p.price)) errors.push('price is required and must be a number');
  else if (p.price < 0) errors.push('price must be ≥ 0');
  if (!Number.isInteger(p.quantity)) errors.push('quantity must be an integer');
  else if (p.quantity < 0) errors.push('quantity must be ≥ 0');
  if (!str(p.sku) || !p.sku.trim()) errors.push('sku is required');
  else if (p.sku.length > 50) errors.push('sku must be ≤ 50 chars');
  return errors.join('; ');
}

// Same normalisation the Express service did: accept numeric strings.
const normalise = (b) => ({
  name: b.name,
  description: b.description || null,
  price: typeof b.price === 'string' ? parseFloat(b.price) : b.price,
  quantity: typeof b.quantity === 'string' ? parseInt(b.quantity, 10) : b.quantity,
  sku: b.sku,
});

const isUnique = (e) => /UNIQUE/i.test(String(e?.message));

async function products(request, env, id) {
  const db = env.shoplist_db;
  const { searchParams } = new URL(request.url);
  const method = request.method;

  if (id === undefined) {
    if (method === 'GET') {
      const page = Math.max(parseInt(searchParams.get('page') || '1', 10) || 1, 1);
      const limit = Math.min(Math.max(parseInt(searchParams.get('limit') || '10', 10) || 10, 1), 100);
      const search = (searchParams.get('search') || '').trim();
      const like = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
      const where = search ? "WHERE name LIKE ?1 ESCAPE '\\' OR sku LIKE ?1 ESCAPE '\\'" : '';
      const args = search ? [like] : [];
      const total = (await db.prepare(`SELECT COUNT(*) AS c FROM products ${where}`).bind(...args).first()).c;
      const { results } = await db
        .prepare(`SELECT * FROM products ${where} ORDER BY created_at DESC, id DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`)
        .bind(...args).all();
      return json({ products: results, page, limit, total });
    }
    if (method === 'POST') {
      const p = normalise(await request.json());
      const err = validate(p);
      if (err) return fail(400, 'Bad Request', err);
      if ((await db.prepare('SELECT COUNT(*) AS c FROM products').first()).c >= MAX_PRODUCTS)
        return fail(400, 'Bad Request', `Demo limit of ${MAX_PRODUCTS} products reached`);
      try {
        const row = await db
          .prepare('INSERT INTO products (name, description, price, quantity, sku) VALUES (?, ?, ?, ?, ?) RETURNING *')
          .bind(p.name, p.description, p.price, p.quantity, p.sku).first();
        return json(row, 201);
      } catch (e) {
        if (isUnique(e)) return fail(409, 'Conflict', 'SKU already exists');
        throw e;
      }
    }
    return fail(405, 'Method Not Allowed', 'Use GET or POST');
  }

  if (method === 'GET') {
    const row = await db.prepare('SELECT * FROM products WHERE id = ?').bind(id).first();
    return row ? json(row) : fail(404, 'Not Found', 'Product not found');
  }
  if (method === 'PUT') {
    const p = normalise(await request.json());
    const err = validate(p);
    if (err) return fail(400, 'Bad Request', err);
    try {
      const row = await db
        .prepare(`UPDATE products SET name = ?, description = ?, price = ?, quantity = ?, sku = ?,
                  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? RETURNING *`)
        .bind(p.name, p.description, p.price, p.quantity, p.sku, id).first();
      return row ? json(row) : fail(404, 'Not Found', 'Product not found');
    } catch (e) {
      if (isUnique(e)) return fail(409, 'Conflict', 'SKU already exists');
      throw e;
    }
  }
  if (method === 'DELETE') {
    // 200 + body (Express returned 204): the front end always calls response.json().
    const row = await db.prepare('DELETE FROM products WHERE id = ? RETURNING id').bind(id).first();
    return row ? json(row) : fail(404, 'Not Found', 'Product not found');
  }
  return fail(405, 'Method Not Allowed', 'Use GET, PUT or DELETE');
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/health') return json({ ok: true });
    const m = pathname.match(/^\/api\/products(?:\/([^/]+))?\/?$/);
    if (!m) return fail(404, 'Not Found', 'API endpoint not found');
    let id;
    if (m[1] !== undefined) {
      if (!/^\d+$/.test(m[1])) return fail(400, 'Bad Request', 'Invalid product id');
      id = Number(m[1]);
    }
    try {
      return await products(request, env, id);
    } catch (e) {
      if (e instanceof SyntaxError) return fail(400, 'Bad Request', 'Invalid JSON');
      return fail(500, 'Internal Server Error', 'Something went wrong');
    }
  },
};
