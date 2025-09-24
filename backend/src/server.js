const express = require('express');
const cors = require('cors');
const path = require('path');
const env = require('./config/env');
const { errorHandler } = require('./middlewares/error');
const productRoutes = require('./routes/products.routes');

const app = express();

// Core middleware
app.use(express.json());
app.use(cors());

// Serve static files from frontend
app.use(express.static(path.join(__dirname, '../../frontend')));

// API Routes
app.use('/api/products', productRoutes);

// Health check
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Serve frontend for all non-API routes
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, '../../frontend/index.html'));
  } else {
    res.status(404).json({ error: 'API endpoint not found' });
  }
});

// Central error handler (must be last)
app.use(errorHandler);

// Start server with error handling
const server = app.listen(env.PORT, () => {
  console.log(`ShopList API running on port ${env.PORT}`);
  console.log(`Health check: http://localhost:${env.PORT}/health`);
});

// Handle server errors
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${env.PORT} is already in use. Please use a different port.`);
    process.exit(1);
  } else {
    console.error('Server error:', err);
    process.exit(1);
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Process terminated');
  });
});