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

// Ruta raíz explícita para asegurar que carga el index.html automáticamente
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 1. Obtener todas las empresas/reservas (GET /api/tenants)
app.get('/api/tenants', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tenants ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error('Error en GET /api/tenants:', err);
    res.status(500).json({ error: 'Error al obtener registros' });
  }
});

// 2. Crear un nuevo registro con hora de reserva y notas (POST /api/tenants)
app.post('/api/tenants', async (req, res) => {
  const { name, phone, category, notes, reservation_time } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO tenants (name, phone, category, notes, reservation_time) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [name, phone, category, notes, reservation_time || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error en POST /api/tenants:', err);
    res.status(500).json({ error: 'Error al crear el registro' });
  }
});

// 3. Actualizar un registro existente incluyendo hora y notas (PUT /api/tenants/:id)
app.put('/api/tenants/:id', async (req, res) => {
  const { id } = req.params;
  const { name, phone, category, notes, reservation_time } = req.body;
  try {
    const result = await pool.query(
      'UPDATE tenants SET name = $1, phone = $2, category = $3, notes = $4, reservation_time = $5 WHERE id = $6 RETURNING *',
      [name, phone, category, notes, reservation_time || null, id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error en PUT /api/tenants/:id:', err);
    res.status(500).json({ error: 'Error al actualizar el registro' });
  }
});

// 4. Endpoint para exportar los datos a formato CSV incluyendo la hora de reserva
app.get('/api/tenants/export', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tenants ORDER BY created_at DESC');
    const tenants = result.rows;

    // Definir las cabeceras del CSV actualizadas
    let csvContent = 'ID,Nombre,Telefono,Categoria,Notas,Hora Reserva,Fecha Creacion\n';

    // Rellenar las filas con los datos de Neon
    tenants.forEach(t => {
      const cleanNotes = (t.notes || '').replace(/"/g, '""').replace(/\n/g, ' ');
      csvContent += `${t.id},"${t.name}","${t.phone}","${t.category}","${cleanNotes}","${t.reservation_time || ''}","${t.created_at}"\n`;
    });

    // Configurar cabeceras HTTP para forzar la descarga del archivo
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=reservas_empresas.csv');
    
    res.status(200).send(csvContent);
  } catch (err) {
    console.error('Error en GET /api/tenants/export:', err);
    res.status(500).json({ error: 'Error al exportar los datos' });
  }
});

// Iniciar servidor
app.listen(port, () => {
  console.log(`Servidor listo escuchando en el puerto ${port}`);
});
