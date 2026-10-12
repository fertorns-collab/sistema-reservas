const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.on('error', (err) => {
  console.error('Error en PostgreSQL:', err);
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        id SERIAL PRIMARY KEY,
        tenant_token VARCHAR(64) UNIQUE,
        admin_token VARCHAR(64) UNIQUE,
        booking_token VARCHAR(64) UNIQUE,
        name VARCHAR(100) NOT NULL,
        phone VARCHAR(30) NOT NULL,
        category VARCHAR(50),
        business_type VARCHAR(100) DEFAULT 'general',
        max_capacity INT DEFAULT 2,
        shift1_start TIME DEFAULT '09:00',
        shift1_end TIME DEFAULT '14:00',
        shift2_start TIME,
        shift2_end TIME,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Tabla para servicios flexibles por negocio
    await pool.query(`
      CREATE TABLE IF NOT EXISTS services (
        id SERIAL PRIMARY KEY,
        tenant_id INT REFERENCES tenants(id) ON DELETE CASCADE,
        name VARCHAR(100) NOT NULL,
        duration_min INT NOT NULL DEFAULT 60,
        price NUMERIC(10,2) DEFAULT 0.00
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS reservations (
        id SERIAL PRIMARY KEY,
        tenant_id INT REFERENCES tenants(id) ON DELETE CASCADE,
        service_id INT REFERENCES services(id) ON DELETE SET NULL,
        client_name VARCHAR(100) NOT NULL,
        client_phone VARCHAR(30) NOT NULL,
        reservation_time TIMESTAMP NOT NULL,
        duration_min INT DEFAULT 60,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Asegurar que la columna service_id existe si la tabla ya estaba creada previamente
    await pool.query(`
      ALTER TABLE reservations ADD COLUMN IF NOT EXISTS service_id INT REFERENCES services(id) ON DELETE SET NULL;
    `);

    console.log('Base de datos inicializada y actualizada con soporte para servicios dinámicos.');
  } catch (err) {
    console.error('Error al inicializar BD:', err);
  }
}
initDB();

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Obtener tenants
app.get('/api/tenants', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tenants ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener registros' });
  }
});

// Obtener servicios de un tenant
app.get('/api/tenants/:id/services', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM services WHERE tenant_id = $1 ORDER BY id ASC', [req.params.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener servicios' });
  }
});

// Guardar servicio
app.post('/api/services', async (req, res) => {
  const { tenant_id, name, duration_min, price } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO services (tenant_id, name, duration_min, price) VALUES ($1, $2, $3, $4) RETURNING *',
      [tenant_id, name, duration_min || 60, price || 0]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Error al crear servicio' });
  }
});

// Borrar servicio
app.delete('/api/services/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM services WHERE id = $1', [req.params.id]);
    res.json({ message: 'Servicio eliminado' });
  } catch (err) {
    res.status(500).json({ error: 'Error al eliminar servicio' });
  }
});

// Guardar/Actualizar empresa
app.post('/api/tenants/config', async (req, res) => {
  const { 
    id, name, phone, category, notes, business_type, 
    max_capacity, shift1_start, shift1_end, shift2_start, shift2_end 
  } = req.body;

  try {
    let result;
    if (id) {
      result = await pool.query(
        `UPDATE tenants SET 
          name = $1, phone = $2, category = $3, notes = $4, business_type = $5, 
          max_capacity = $6, shift1_start = $7, shift1_end = $8, 
          shift2_start = $9, shift2_end = $10 
         WHERE id = $11 RETURNING *`,
        [
          name, phone, category || null, notes || '', business_type || 'general',
          max_capacity || 2, shift1_start || '09:00', shift1_end || '14:00',
          shift2_start || null, shift2_end || null, id
        ]
      );
    } else {
      const adminToken = crypto.randomBytes(16).toString('hex');
      const bookingToken = crypto.randomBytes(16).toString('hex');

      result = await pool.query(
        `INSERT INTO tenants 
          (tenant_token, admin_token, booking_token, name, phone, category, notes, business_type, max_capacity, shift1_start, shift1_end, shift2_start, shift2_end) 
         VALUES ($1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) 
         RETURNING *`,
        [
          adminToken, bookingToken, name, phone, category || null, notes || '',
          business_type || 'general', max_capacity || 2, 
          shift1_start || '09:00', shift1_end || '14:00', shift2_start || null, shift2_end || null
        ]
      );
      
      const newTenantId = result.rows[0].id;
      await pool.query(
        'INSERT INTO services (tenant_id, name, duration_min, price) VALUES ($1, $2, $3, $4)',
        [newTenantId, 'Sesión Estándar', 60, 0]
      );
    }

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error al guardar:', err);
    res.status(500).json({ error: 'Error al guardar configuración' });
  }
});

// Disponibilidad basada en la duración del servicio seleccionado por el cliente
app.get('/api/tenants/:id/availability', async (req, res) => {
  const tenantId = req.params.id;
  const { date, service_id } = req.query;

  if (!date || !service_id) {
    return res.status(400).json({ error: 'Proporciona fecha y service_id' });
  }

  try {
    const tenantRes = await pool.query('SELECT * FROM tenants WHERE id = $1', [tenantId]);
    const serviceRes = await pool.query('SELECT * FROM services WHERE id = $1', [service_id]);

    if (tenantRes.rows.length === 0 || serviceRes.rows.length === 0) {
      return res.status(404).json({ error: 'Negocio o servicio no encontrado' });
    }

    const tenant = tenantRes.rows[0];
    const service = serviceRes.rows[0];
    const durationMin = service.duration_min;

    const reservationsRes = await pool.query(
      `SELECT reservation_time, duration_min FROM reservations 
       WHERE tenant_id = $1 AND DATE(reservation_time) = $2`,
      [tenantId, date]
    );

    const activeReservations = reservationsRes.rows;
    const slots = [];

    const addShiftsToSlots = (startStr, endStr) => {
      if (!startStr || !endStr) return;
      let current = new Date(`${date}T${startStr}`);
      const end = new Date(`${date}T${endStr}`);

      while (current < end) {
        const timeStr = current.toTimeString().substring(0, 5);
        slots.push(timeStr);
        current = new Date(current.getTime() + 30 * 60000);
      }
    };

    addShiftsToSlots(tenant.shift1_start, tenant.shift1_end);
    addShiftsToSlots(tenant.shift2_start, tenant.shift2_end);

    const availability = slots.map(slotTime => {
      const slotStart = new Date(`${date}T${slotTime}:00`).getTime();
      const slotEnd = slotStart + durationMin * 60000;

      const overlappingCount = activeReservations.filter(r => {
        const rStart = new Date(r.reservation_time).getTime();
        const rDuration = r.duration_min || 60;
        const rEnd = rStart + rDuration * 60000;

        return slotStart < rEnd && slotEnd > rStart;
      }).length;

      const isFull = overlappingCount >= (tenant.max_capacity || 2);

      return {
        time: slotTime,
        available: !isFull,
        bookedCount: overlappingCount,
        maxCapacity: tenant.max_capacity || 2,
        durationMin: durationMin
      };
    });

    res.json({
      date,
      business_name: tenant.name,
      service_name: service.name,
      duration_min: durationMin,
      slots: availability
    });

  } catch (err) {
    console.error('Error disponibilidad:', err);
    res.status(500).json({ error: 'Error interno al consultar disponibilidad' });
  }
});

// Crear reserva vinculada al servicio y su duración
app.post('/api/reservations', async (req, res) => {
  const { tenant_id, service_id, client_name, client_phone, reservation_time, notes } = req.body;

  try {
    const serviceRes = await pool.query('SELECT duration_min FROM services WHERE id = $1', [service_id]);
    if (serviceRes.rows.length === 0) {
      return res.status(404).json({ error: 'Servicio no válido' });
    }
    
    const durationMin = serviceRes.rows[0].duration_min || 60;

    const insertResult = await pool.query(
      `INSERT INTO reservations (tenant_id, service_id, client_name, client_phone, reservation_time, duration_min, notes) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [tenant_id, service_id, client_name, client_phone, reservation_time, durationMin, notes || 'Reserva confirmada']
    );

    res.status(201).json({
      message: 'Reserva realizada con éxito',
      reservation: insertResult.rows[0]
    });
  } catch (err) {
    console.error('Error reserva:', err);
    res.status(500).json({ error: 'Error al procesar reserva: ' + err.message });
  }
});

// Exportar CSV
app.get('/api/tenants/export', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT t.name as empresa, s.name as servicio, r.client_name, r.client_phone, r.reservation_time, r.duration_min, r.notes 
      FROM reservations r
      JOIN tenants t ON r.tenant_id = t.id
      LEFT JOIN services s ON r.service_id = s.id
      ORDER BY r.reservation_time DESC
    `);

    let csvContent = 'Empresa,Servicio,Cliente,Telefono,Fecha Hora,Duracion (min),Notas\n';
    result.rows.forEach(row => {
      const cleanNotes = (row.notes || '').replace(/"/g, '""').replace(/\n/g, ' ');
      csvContent += `"${row.empresa}","${row.servicio || ''}","${row.client_name || ''}","${row.client_phone || ''}","${row.reservation_time}","${row.duration_min}","${cleanNotes}"\n`;
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=reservas_servicios.csv');
    res.status(200).send(csvContent);
  } catch (err) {
    res.status(500).json({ error: 'Error al exportar' });
  }
});

app.listen(port, () => {
  console.log(`Servidor en puerto ${port}`);
});
