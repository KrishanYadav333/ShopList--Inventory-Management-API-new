// Creates a single shared connection pool to PostgreSQL
const { Pool } = require('pg');
const env = require('../config/env');

let pool = null;
let isConnected = false;

// Only create pool if DATABASE_URL is provided and looks valid
if (env.DATABASE_URL && env.DATABASE_URL.startsWith('postgres://')) {
  try {
    pool = new Pool({ 
      connectionString: env.DATABASE_URL,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000
    });

    // Handle pool errors
    pool.on('error', (err) => {
      console.error('Database pool error:', err.message);
      isConnected = false;
    });

    // Test connection on startup (non-blocking)
    pool.connect()
      .then((client) => {
        console.log('Database connected successfully');
        isConnected = true;
        client.release();
      })
      .catch((err) => {
        console.warn('Database connection failed:', err.message);
        console.warn('Running in mock mode without database');
        isConnected = false;
        pool = null;
      });
  } catch (error) {
    console.warn('Failed to create database pool:', error.message);
    console.warn('Running in mock mode without database');
    pool = null;
  }
} else {
  console.warn('No valid DATABASE_URL provided - running in mock mode');
}

function isDatabaseConnected() {
  return pool !== null && isConnected;
}

module.exports = { pool, isDatabaseConnected };