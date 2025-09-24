const fs = require('fs');
const path = require('path');
const { pool } = require('./pool');

async function runMigration() {
  try {
    console.log('Running database migration...');
    
    // Test connection first
    await pool.query('SELECT NOW()');
    console.log('Database connection successful!');
    
    const migrationPath = path.join(__dirname, 'migrations', '001_init.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');
    
    await pool.query(sql);
    console.log('Migration completed successfully!');
    
    await pool.end();
  } catch (error) {
    console.error('Database connection failed:', error.message);
    console.error('Please ensure PostgreSQL is running and DATABASE_URL is correct.');
    console.error('Current DATABASE_URL:', process.env.DATABASE_URL || 'Not set');
    process.exit(1);
  }
}

runMigration();