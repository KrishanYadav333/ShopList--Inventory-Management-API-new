// Centralized error handler mapping DB and validation errors to JSON
function errorHandler(err, req, res, next) {
  console.error('Error handler caught:', err);

  // Unique violation (e.g., duplicate sku) → 409 Conflict
  if (err && err.code === '23505') {
    return res.status(409).json({ error: 'Conflict', message: 'SKU already exists' });
  }

  // Invalid UUID or similar casting errors → 400 Bad Request
  if (err && (err.code === '22P02' || err.type === 'validation')) {
    const message = err.message || 'Invalid input';
    return res.status(400).json({ error: 'Bad Request', message });
  }

  // Not found surfaced explicitly by services/controllers
  if (err && err.type === 'not_found') {
    return res.status(404).json({ error: 'Not Found', message: err.message || 'Resource not found' });
  }

  // Fallback: 500 Internal Server Error
  console.error('Unhandled error:', err.stack || err);
  return res.status(500).json({ 
    error: 'Internal Server Error', 
    message: err.message || 'Something went wrong',
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
}

module.exports = { errorHandler };