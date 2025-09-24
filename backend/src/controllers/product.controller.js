const service = require('../services/product.service');
const { parsePagination } = require('../utils/pagination');

// --- POST /products (first to implement) ---
async function createProduct(req, res, next) {
  try {
    console.log('Creating product with data:', req.body);
    const created = await service.create(req.body);
    console.log('Product created successfully:', created);
    return res.status(201).json(created);
  } catch (err) {
    console.error('Error creating product:', err);
    return next(err);
  }
}

// --- GET /products (with pagination & search) ---
async function getProducts(req, res, next) {
  try {
    const pagination = parsePagination(req.query);
    const search = typeof req.query.search === 'string' && req.query.search.trim() !== ''
      ? req.query.search.trim()
      : undefined;

    const { rows, total } = await service.list({ pagination, search });
    return res.json({
      products: rows,
      page: pagination.page,
      limit: pagination.limit,
      total
    });
  } catch (err) {
    return next(err);
  }
}

// --- GET /products/:id ---
async function getProductById(req, res, next) {
  try {
    const item = await service.getById(req.params.id);
    return res.json(item);
  } catch (err) {
    return next(err);
  }
}

// --- PUT /products/:id ---
async function updateProduct(req, res, next) {
  try {
    const updated = await service.update(req.params.id, req.body);
    return res.json(updated);
  } catch (err) {
    return next(err);
  }
}

// --- DELETE /products/:id ---
async function deleteProduct(req, res, next) {
  try {
    await service.remove(req.params.id);
    return res.status(204).send();
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  createProduct,
  getProducts,
  getProductById,
  updateProduct,
  deleteProduct
};