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
        closed_days VARCHAR(50) DEFAULT '0',
        shift1_start TIME DEFAULT '09:00',
        shift1_end TIME DEFAULT '14:00',
        shift2_start TIME,
        shift2_end TIME,
        closing_times JSONB DEFAULT '{}',
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

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
        booking_code VARCHAR(20) UNIQUE,
        reservation_time TIMESTAMP NOT NULL,
        duration_min INT DEFAULT 60,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS business_exceptions (
        id SERIAL PRIMARY KEY,
        tenant_id INT REFERENCES tenants(id) ON DELETE CASCADE,
        exception_date DATE NOT NULL,
        is_closed BOOLEAN DEFAULT TRUE,
        reason VARCHAR(150),
        UNIQUE(tenant_id, exception_date)
      );
    `);

    await pool.query(`
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS closed_days VARCHAR(50) DEFAULT '0';
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS closing_times JSONB DEFAULT '{}';
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS admin_token VARCHAR(64) UNIQUE;
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS booking_token VARCHAR(64) UNIQUE;
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS tenant_token VARCHAR(64) UNIQUE;
    `);

    console.log('Base de datos inicializada con éxito.');
  } catch (err) {
    console.error('Error al inicializar BD:', err);
  }
}
initDB();

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Endpoint para validar el token de cliente
app.get('/api/client/tenant/:token', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, phone, category, business_type, max_capacity, booking_token FROM tenants WHERE booking_token = $1',
      [req.params.token]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Enlace de reserva no válido' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener datos del negocio' });
  }
});

// Endpoint para validar el token de administración del gerente
app.get('/api/admin/tenant/:token', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM tenants WHERE admin_token = $1',
      [req.params.token]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Acceso de administración no autorizado' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Error al verificar credenciales' });
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

app.delete('/api/services/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM services WHERE id = $1', [req.params.id]);
    res.json({ message: 'Servicio eliminado' });
  } catch (err) {
    res.status(500).json({ error: 'Error al eliminar servicio' });
  }
});

// Excepciones / Festivos
app.get('/api/tenants/:id/exceptions', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM business_exceptions WHERE tenant_id = $1 ORDER BY exception_date ASC', [req.params.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener excepciones' });
  }
});

app.post('/api/tenants/exceptions', async (req, res) => {
  const { tenant_id, exception_date, is_closed, reason } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO business_exceptions (tenant_id, exception_date, is_closed, reason) 
       VALUES ($1, $2, $3, $4) 
       ON CONFLICT (tenant_id, exception_date) 
       DO UPDATE SET is_closed = EXCLUDED.is_closed, reason = EXCLUDED.reason 
       RETURNING *`,
      [tenant_id, exception_date, is_closed ?? true, reason || 'Festivo']
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Error al guardar excepción' });
  }
});

app.delete('/api/tenants/exceptions/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM business_exceptions WHERE id = $1', [req.params.id]);
    res.json({ message: 'Excepción eliminada' });
  } catch (err) {
    res.status(500).json({ error: 'Error al eliminar excepción' });
  }
});

// Guardar/Crear empresa con control completo de turnos, horarios y generación segura de tokens
app.post('/api/tenants/config', async (req, res) => {
  const { 
    id, name, phone, category, notes, business_type, 
    max_capacity, closed_days, shift1_start, shift1_end, shift2_start, shift2_end, closing_times 
  } = req.body;

  try {
    let result;
    const closingTimesJson = closing_times ? JSON.stringify(closing_times) : '{}';

    if (id) {
      result = await pool.query(
        `UPDATE tenants SET 
          name = $1, phone = $2, category = $3, notes = $4, business_type = $5, 
          max_capacity = $6, closed_days = $7, shift1_start = $8, shift1_end = $9, 
          shift2_start = $10, shift2_end = $11, closing_times = $12 
         WHERE id = $13 RETURNING *`,
        [
          name, phone, category || null, notes || '', business_type || 'general',
          max_capacity || 2, closed_days || '0', shift1_start || '09:00', shift1_end || '14:00',
          shift2_start || null, shift2_end || null, closingTimesJson, id
        ]
      );
    } else {
      const tenantToken = crypto.randomBytes(16).toString('hex');
      const adminToken = crypto.randomBytes(16).toString('hex');
      const bookingToken = crypto.randomBytes(16).toString('hex');

      result = await pool.query(
        `INSERT INTO tenants 
          (tenant_token, admin_token, booking_token, name, phone, category, notes, business_type, max_capacity, closed_days, shift1_start, shift1_end, shift2_start, shift2_end, closing_times) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) 
         RETURNING *`,
        [
          tenantToken, adminToken, bookingToken, name, phone, category || null, notes || '',
          business_type || 'general', max_capacity || 2, closed_days || '0',
          shift1_start || '09:00', shift1_end || '14:00', shift2_start || null, shift2_end || null,
          closingTimesJson
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
    console.error('Error al guardar configuración:', err);
    res.status(500).json({ error: 'Error al guardar configuración: ' + err.message });
  }
});

// Disponibilidad inteligente
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

    const targetDateObj = new Date(date + 'T00:00:00Z');
    const dayOfWeek = targetDateObj.getUTCDay().toString();
    const closedDaysArray = (tenant.closed_days || '').split(',').map(d => d.trim());

    let isClosedByDefault = closedDaysArray.includes(dayOfWeek);

    const exceptionRes = await pool.query(
      'SELECT * FROM business_exceptions WHERE tenant_id = $1 AND exception_date = $2',
      [tenantId, date]
    );

    let finalIsClosed = isClosedByDefault;
    if (exceptionRes.rows.length > 0) {
      finalIsClosed = exceptionRes.rows[0].is_closed;
    }

    if (finalIsClosed) {
      return res.json({
        date,
        business_name: tenant.name,
        service_name: service.name,
        duration_min: durationMin,
        closed: true,
        reason: exceptionRes.rows.length > 0 ? exceptionRes.rows[0].reason : 'Día de descanso semanal',
        slots: []
      });
    }

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

    const closingTimes = tenant.closing_times || {};
    const earlyCloseTime = closingTimes[dayOfWeek];

    if (earlyCloseTime) {
      addShiftsToSlots(tenant.shift1_start, earlyCloseTime);
    } else {
      addShiftsToSlots(tenant.shift1_start, tenant.shift1_end);
      addShiftsToSlots(tenant.shift2_start, tenant.shift2_end);
    }

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
      closed: false,
      slots: availability
    });

  } catch (err) {
    console.error('Error disponibilidad:', err);
    res.status(500).json({ error: 'Error interno al consultar disponibilidad' });
  }
});

// Endpoints de reservas
app.get('/api/reservations', async (req, res) => {
  const { tenant_id, phone, code, start_date, end_date } = req.query;
  try {
    let query = `
      SELECT r.*, s.name as service_name, t.name as tenant_name 
      FROM reservations r
      LEFT JOIN services s ON r.service_id = s.id
      JOIN tenants t ON r.tenant_id = t.id
      WHERE r.tenant_id = $1
    `;
    let params = [tenant_id];

    if (phone && code) {
      query += ` AND r.client_phone = $2 AND r.booking_code = $3`;
      params.push(phone, code);
    } else if (start_date && end_date) {
      query += ` AND DATE(r.reservation_time) >= $2 AND DATE(r.reservation_time) <= $3`;
      params.push(start_date, end_date);
    } else if (phone) {
      query += ` AND r.client_phone = $2`;
      params.push(phone);
    }

    query += ` ORDER BY r.reservation_time DESC`;
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener reservas' });
  }
});

app.post('/api/reservations', async (req, res) => {
  const { id, tenant_id, service_id, client_name, client_phone, reservation_time, notes } = req.body;

  try {
    const serviceRes = await pool.query('SELECT duration_min FROM services WHERE id = $1', [service_id]);
    if (serviceRes.rows.length === 0) return res.status(404).json({ error: 'Servicio no válido' });
    
    const durationMin = serviceRes.rows[0].duration_min || 60;

    let result;
    if (id) {
      result = await pool.query(
        `UPDATE reservations SET service_id = $1, client_name = $2, client_phone = $3, reservation_time = $4, duration_min = $5, notes = $6 
         WHERE id = $7 RETURNING *`,
        [service_id, client_name, client_phone, reservation_time, durationMin, notes || '', id]
      );
    } else {
      const bookingCode = 'RES-' + Math.floor(1000 + Math.random() * 9000);
      result = await pool.query(
        `INSERT INTO reservations (tenant_id, service_id, client_name, client_phone, booking_code, reservation_time, duration_min, notes) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [tenant_id, service_id, client_name, client_phone, bookingCode, reservation_time, durationMin, notes || 'Reserva confirmada']
      );
    }

    res.status(201).json({ message: 'Reserva procesada con éxito', reservation: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Error al procesar reserva: ' + err.message });
  }
});

app.delete('/api/reservations/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM reservations WHERE id = $1', [req.params.id]);
    res.json({ message: 'Reserva anulada con éxito' });
  } catch (err) {
    res.status(500).json({ error: 'Error al anular reserva' });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
