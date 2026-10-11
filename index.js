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
app.use(express.static(path.join(__dirname, 'public')));

// Inicialización de esquema de Base de Datos
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        phone VARCHAR(30) NOT NULL,
        category VARCHAR(50),
        business_type VARCHAR(100) DEFAULT 'general',
        max_capacity INT DEFAULT 2,
        default_duration_min INT DEFAULT 60,
        shift1_start TIME DEFAULT '09:00',
        shift1_end TIME DEFAULT '14:00',
        shift2_start TIME,
        shift2_end TIME,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS reservations (
        id SERIAL PRIMARY KEY,
        tenant_id INT REFERENCES tenants(id) ON DELETE CASCADE,
        client_name VARCHAR(100) NOT NULL,
        client_phone VARCHAR(30) NOT NULL,
        reservation_time TIMESTAMP NOT NULL,
        duration_min INT DEFAULT 60,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('Tablas inicializadas correctamente.');
  } catch (err) {
    console.error('Error al inicializar la base de datos:', err);
  }
}
initDB();

// Ruta raíz explícita
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 1. Obtener todas las empresas (GET /api/tenants)
app.get('/api/tenants', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tenants ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error('Error en GET /api/tenants:', err);
    res.status(500).json({ error: 'Error al obtener registros' });
  }
});

// 2. Configurar, crear o actualizar un negocio con turnos y capacidad (POST /api/tenants/config)
app.post('/api/tenants/config', async (req, res) => {
  const { 
    id, // Recibimos el id opcionalmente para saber si es actualización
    name, phone, category, notes, business_type, 
    max_capacity, default_duration_min,
    shift1_start, shift1_end, shift2_start, shift2_end 
  } = req.body;

  try {
    let result;
    if (id) {
      // Actualizar empresa existente para evitar duplicados
      result = await pool.query(
        `UPDATE tenants SET 
          name = $1, phone = $2, category = $3, notes = $4, business_type = $5, 
          max_capacity = $6, default_duration_min = $7, shift1_start = $8, 
          shift1_end = $9, shift2_start = $10, shift2_end = $11 
         WHERE id = $12 RETURNING *`,
        [
          name, phone, category || null, notes, business_type || 'general',
          max_capacity || 2, default_duration_min || 60,
          shift1_start || '09:00', shift1_end || '14:00',
          shift2_start || null, shift2_end || null, id
        ]
      );
    } else {
      // Crear nueva empresa si no hay ID
      result = await pool.query(
        `INSERT INTO tenants 
          (name, phone, category, notes, business_type, max_capacity, default_duration_min, shift1_start, shift1_end, shift2_start, shift2_end) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) 
         RETURNING *`,
        [
          name, phone, category || null, notes, business_type || 'general',
          max_capacity || 2, default_duration_min || 60,
          shift1_start || '09:00', shift1_end || '14:00',
          shift2_start || null, shift2_end || null
        ]
      );
    }

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error al guardar configuración:', err);
    res.status(500).json({ error: 'Error al guardar la configuración del negocio' });
  }
});

// 3. Consultar disponibilidad en tiempo real para una fecha y tenant (GET /api/tenants/:id/availability)
app.get('/api/tenants/:id/availability', async (req, res) => {
  const tenantId = req.params.id;
  const { date } = req.query; // Formato requerido: 'YYYY-MM-DD'

  if (!date) {
    return res.status(400).json({ error: 'Debes proporcionar una fecha (YYYY-MM-DD)' });
  }

  try {
    const tenantRes = await pool.query('SELECT * FROM tenants WHERE id = $1', [tenantId]);
    if (tenantRes.rows.length === 0) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }
    const tenant = tenantRes.rows[0];

    const reservationsRes = await pool.query(
      `SELECT reservation_time FROM reservations 
       WHERE tenant_id = $1 AND DATE(reservation_time) = $2`,
      [tenantId, date]
    );

    const activeReservations = reservationsRes.rows;
    const intervalMinutes = tenant.default_duration_min || 60;
    const slots = [];

    const addShiftsToSlots = (startStr, endStr) => {
      if (!startStr || !endStr) return;
      let current = new Date(`${date}T${startStr}`);
      const end = new Date(`${date}T${endStr}`);

      while (current < end) {
        const timeStr = current.toTimeString().substring(0, 5);
        slots.push(timeStr);
        current = new Date(current.getTime() + intervalMinutes * 60000);
      }
    };

    addShiftsToSlots(tenant.shift1_start, tenant.shift1_end);
    addShiftsToSlots(tenant.shift2_start, tenant.shift2_end);

    const availability = slots.map(slotTime => {
      const count = activeReservations.filter(r => {
        if (!r.reservation_time) return false;
        const rTime = new Date(r.reservation_time).toTimeString().substring(0, 5);
        return rTime === slotTime;
      }).length;

      const isFull = count >= (tenant.max_capacity || 2);

      return {
        time: slotTime,
        available: !isFull,
        bookedCount: count,
        maxCapacity: tenant.max_capacity || 2
      };
    });

    res.json({
      date,
      business_type: tenant.business_type,
      slots: availability
    });

  } catch (err) {
    console.error('Error al calcular disponibilidad:', err);
    res.status(500).json({ error: 'Error interno al consultar la disponibilidad' });
  }
});

// 4. Crear reserva validando turnos y capacidad (POST /api/reservations)
app.post('/api/reservations', async (req, res) => {
  const { tenant_id, client_name, client_phone, reservation_time, duration_min, notes } = req.body;

  try {
    const tenantRes = await pool.query('SELECT * FROM tenants WHERE id = $1', [tenant_id]);
    if (tenantRes.rows.length === 0) {
      return res.status(404).json({ error: 'El negocio no existe' });
    }
    const tenant = tenantRes.rows[0];

    const requestedDate = new Date(reservation_time);
    const timeString = requestedDate.toTimeString().substring(0, 5);

    // Validar horario comercial (Turno 1 y Turno 2)
    const inShift1 = tenant.shift1_start && tenant.shift1_end && 
                     (timeString >= tenant.shift1_start && timeString < tenant.shift1_end);
    const inShift2 = tenant.shift2_start && tenant.shift2_end && 
                     (timeString >= tenant.shift2_start && timeString < tenant.shift2_end);

    if (!inShift1 && !inShift2) {
      return res.status(400).json({ 
        error: 'El horario seleccionado está fuera del horario comercial del negocio.' 
      });
    }

    // Validar capacidad máxima
    const countResult = await pool.query(
      `SELECT COUNT(*) FROM reservations 
       WHERE tenant_id = $1 AND reservation_time = $2`,
      [tenant_id, reservation_time]
    );

    const activeReservations = parseInt(countResult.rows[0].count);

    if (activeReservations >= (tenant.max_capacity || 2)) {
      return res.status(400).json({ 
        error: 'El tramo horario seleccionado ya está completo. Por favor, elige otra hora.' 
      });
    }

    // Guardar la reserva
    const insertResult = await pool.query(
      `INSERT INTO reservations (tenant_id, client_name, client_phone, reservation_time, duration_min, notes) 
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [tenant_id, client_name, client_phone, reservation_time, duration_min || tenant.default_duration_min || 60, notes || 'Reserva confirmada']
    );

    res.status(201).json({
      message: 'Reserva realizada con éxito',
      reservation: insertResult.rows[0]
    });

  } catch (err) {
    console.error('Error al procesar reserva:', err);
    res.status(500).json({ error: 'Error interno al procesar la reserva' });
  }
});

// 5. Exportar reservas a CSV (GET /api/tenants/export)
app.get('/api/tenants/export', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT t.name as empresa, t.business_type, r.client_name, r.client_phone, r.reservation_time, r.notes 
      FROM reservations r
      JOIN tenants t ON r.tenant_id = t.id
      ORDER BY r.reservation_time DESC
    `);

    let csvContent = 'Empresa,Tipo Negocio,Cliente,Telefono,Fecha Hora,Notas\n';
    result.rows.forEach(row => {
      const cleanNotes = (row.notes || '').replace(/"/g, '""').replace(/\n/g, ' ');
      csvContent += `"${row.empresa}","${row.business_type || ''}","${row.client_name || ''}","${row.client_phone || ''}","${row.reservation_time}","${cleanNotes}"\n`;
    });

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
