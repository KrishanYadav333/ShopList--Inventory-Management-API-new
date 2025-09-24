// Loads environment variables and exports them in one place
require('dotenv').config();

const env = {
  PORT: process.env.PORT || 3000,
  DATABASE_URL: process.env.DATABASE_URL,
  BASIC_AUTH_USER: process.env.BASIC_AUTH_USER || 'admin',
  BASIC_AUTH_PASS: process.env.BASIC_AUTH_PASS || 'secret'
};

// Validate required environment variables
if (!env.DATABASE_URL) {
  console.warn('Warning: DATABASE_URL not set. Please configure your database connection.');
  console.warn('Example: DATABASE_URL=postgres://user:pass@localhost:5432/shoplist');
}

module.exports = env;