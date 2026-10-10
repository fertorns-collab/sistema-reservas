const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Configuración de la base de datos PostgreSQL (Neon)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Control de errores globales en el pool de conexión
pool.on('error', (err) => {
  console.error('Error inesperado en el cliente de PostgreSQL:', err);
});

// Middleware
app.use(express.json());
// Servir la carpeta 'public' de forma estática
app.use(express.static(path.join(__dirname, 'public')));

// 1. Obtener todas las empresas (GET /api/tenants)
app.get('/api/tenants', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tenants ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error('Error en GET /api/tenants:', err);
    res.status(500).json({ error: 'Error al obtener empresas' });
  }
});

// 2. Crear una nueva empresa (POST /api/tenants)
app.post('/api/tenants', async (req, res) => {
  const { name, phone, category } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO tenants (name, phone, category) VALUES ($1, $2, $3) RETURNING *',
      [name, phone, category]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error en POST /api/tenants:', err);
    res.status(500).json({ error: 'Error al crear la empresa' });
  }
});

// 3. Actualizar una empresa existente (PUT /api/tenants/:id)
app.put('/api/tenants/:id', async (req, res) => {
  const { id } = req.params;
  const { name, phone, category } = req.body;
  try {
    const result = await pool.query(
      'UPDATE tenants SET name = $1, phone = $2, category = $3 WHERE id = $4 RETURNING *',
      [name, phone, category, id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error en PUT /api/tenants/:id:', err);
    res.status(500).json({ error: 'Error al actualizar la empresa' });
  }
});

// Iniciar servidor
app.listen(port, () => {
  console.log(`Servidor listo escuchando en el puerto ${port}`);
});
