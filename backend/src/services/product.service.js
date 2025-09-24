const repo = require('../repos/product.repo');

// Simple validators kept here to maintain Controller → Service separation.
// Throw { type: 'validation', message } for 400 mapping.
function validateProductPayload(payload) {
  const errors = [];

  const str = (v) => typeof v === 'string';
  const num = (v) => typeof v === 'number' && !Number.isNaN(v);
  const int = (v) => Number.isInteger(v);

  // name
  if (!str(payload.name) || payload.name.trim().length === 0) errors.push('name is required');
  else if (payload.name.length > 100) errors.push('name must be ≤ 100 chars');

  // description (optional)
  if (payload.description !== undefined && payload.description !== null) {
    if (!str(payload.description)) errors.push('description must be a string');
    else if (payload.description.length > 500) errors.push('description must be ≤ 500 chars');
  }

  // price
  if (!num(payload.price)) errors.push('price is required and must be a number');
  else if (payload.price < 0) errors.push('price must be ≥ 0');

  // quantity
  if (!num(payload.quantity) || !int(payload.quantity)) errors.push('quantity must be an integer');
  else if (payload.quantity < 0) errors.push('quantity must be ≥ 0');

  // sku
  if (!str(payload.sku) || payload.sku.trim().length === 0) errors.push('sku is required');
  else if (payload.sku.length > 50) errors.push('sku must be ≤ 50 chars');

  if (errors.length) {
    const message = errors.join('; ');
    const e = new Error(message);
    e.type = 'validation';
    throw e;
  }
}

async function create(data) {
  console.log('Service: Creating product with data:', data);
  try {
    // Normalize data types
    const normalizedData = {
      name: data.name,
      description: data.description || null,
      price: typeof data.price === 'string' ? parseFloat(data.price) : data.price,
      quantity: typeof data.quantity === 'string' ? parseInt(data.quantity) : data.quantity,
      sku: data.sku
    };
    
    console.log('Service: Normalized data:', normalizedData);
    validateProductPayload(normalizedData);
    console.log('Service: Validation passed');
    const result = await repo.insertProduct(normalizedData);
    console.log('Service: Product created:', result);
    return result;
  } catch (error) {
    console.error('Service: Error creating product:', error);
    throw error;
  }
}

async function list({ pagination, search }) {
  return repo.findProducts({ offset: pagination.offset, limit: pagination.limit, search });
}

async function getById(id) {
  const item = await repo.findById(id);
  if (!item) {
    const e = new Error('Product not found');
    e.type = 'not_found';
    throw e;
  }
  return item;
}

async function update(id, data) {
  validateProductPayload(data);
  const updated = await repo.updateProduct(id, data);
  if (!updated) {
    const e = new Error('Product not found');
    e.type = 'not_found';
    throw e;
  }
  return updated;
}

async function remove(id) {
  const removed = await repo.removeProduct(id);
  if (!removed) {
    const e = new Error('Product not found');
    e.type = 'not_found';
    throw e;
  }
  return removed;
}

module.exports = { create, list, getById, update, remove };