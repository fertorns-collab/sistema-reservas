const { Pool } = require('pg');

// Render provee process.env.DATABASE_URL automáticamente
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Prueba de conexión
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('Error conectando a PostgreSQL:', err);
  } else {
    console.log('¡Conexión exitosa a PostgreSQL en producción! Hora del servidor:', res.rows[0].now);
  }
});