import express from 'express';
import pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcrypt';
import crypto from 'crypto';

// Actualización forzada - Soporte robusto panadería y cancelación admin
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const initDB = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        slug VARCHAR(50) UNIQUE,
        business_type VARCHAR(50) DEFAULT 'general',
        max_capacity INT DEFAULT 10,
        whatsapp_phone VARCHAR(20),
        email VARCHAR(100) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        settings JSONB,
        services JSONB DEFAULT '[]',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS reservations (
        id SERIAL PRIMARY KEY,
        tenant_id INT REFERENCES tenants(id) ON DELETE CASCADE,
        client_name VARCHAR(100) NOT NULL,
        client_phone VARCHAR(20) NOT NULL,
        booking_code VARCHAR(10) UNIQUE,
        reservation_date DATE NOT NULL,
        time_slot VARCHAR(50) NOT NULL,
        end_time VARCHAR(50) NOT NULL,
        service_name VARCHAR(100),
        party_size INT DEFAULT 1,
        resource_assigned VARCHAR(50),
        status VARCHAR(20) DEFAULT 'confirmed',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log("Base de datos inicializada correctamente.");
  } catch (err) {
    console.error("Error al inicializar la base de datos:", err.message);
  }
};
initDB();

const timeToMins = (timeStr) => {
  const [h, m] = (timeStr || "00:00").split(':').map(Number);
  return h * 60 + (m || 0);
};

const minsToTime = (totalMins) => {
  const h = Math.floor(totalMins / 60).toString().padStart(2, '0');
  const m = (totalMins % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
};

const getEffectiveBusinessType = (rawType) => {
  const bTypeLower = String(rawType || 'general').toLowerCase();
  if (bTypeLower.includes('pádel') || bTypeLower.includes('padel') || bTypeLower.includes('pista') || bTypeLower.includes('deporte')) {
    return 'court_rental';
  } else if (bTypeLower.includes('peluquería') || bTypeLower.includes('peluqueria') || bTypeLower.includes('estética') || bTypeLower.includes('cita')) {
    return 'appointment';
  } else if (bTypeLower.includes('restaurante') || bTypeLower.includes('mesa')) {
    return 'table_booking';
  } else if (bTypeLower.includes('panadería') || bTypeLower.includes('panaderia') || bTypeLower.includes('tienda') || bTypeLower.includes('comercio')) {
    return 'bakery';
  }
  return 'general';
};

app.get('/api/tenants', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, slug, business_type, max_capacity, whatsapp_phone FROM tenants ORDER BY name ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tenant/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const tenantRes = await pool.query(
      'SELECT id, name, slug, business_type, max_capacity, whatsapp_phone, settings, services FROM tenants WHERE slug = $1', 
      [slug]
    );
    if (tenantRes.rows.length === 0) return res.status(404).json({ error: 'Negocio no encontrado' });
    
    let tenant = tenantRes.rows[0];
    if (typeof tenant.services === 'string') {
      try { tenant.services = JSON.parse(tenant.services); } catch (e) { tenant.services = ['General']; }
    }
    if (typeof tenant.settings === 'string') {
      try { tenant.settings = JSON.parse(tenant.settings); } catch (e) { tenant.settings = {}; }
    }

    res.json(tenant);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/availability/:tenant_id', async (req, res) => {
  try {
    const { tenant_id } = req.params;
    const { date, service_name, duration, party_size } = req.query;

    const tenantInfo = await pool.query('SELECT business_type, max_capacity, settings FROM tenants WHERE id = $1', [tenant_id]);
    if (tenantInfo.rows.length === 0) return res.status(404).json({ error: 'Negocio no encontrado' });

    let tenant = tenantInfo.rows[0];
    let settings = tenant.settings;
    if (typeof settings === 'string') { try { settings = JSON.parse(settings); } catch (e) { settings = {}; } }

    const businessType = getEffectiveBusinessType(tenant.business_type);
    const maxCapacity = tenant.max_capacity || 50;

    const dateObj = new Date(date + 'T00:00:00');
    const dayOfWeek = dateObj.getDay();
    const closedDays = settings.closedDays || [];

    if (closedDays.includes(dayOfWeek)) {
      return res.json({ closed: true, message: "Negocio cerrado en este día." });
    }

    const shifts = settings.shifts || [{ open: "08:00", close: "20:00" }];
    let slotDurationMinutes = 60;
    if (businessType === 'bakery') slotDurationMinutes = 30;

    let slots = [];
    shifts.forEach(shift => {
      let currentMins = timeToMins(shift.open || "08:00");
      let closeMins = timeToMins(shift.close || "20:00");
      while (currentMins + slotDurationMinutes <= closeMins) {
        slots.push(minsToTime(currentMins));
        currentMins += 30;
      }
    });

    if (slots.length === 0) slots = ["09:00", "10:00", "11:00", "12:00", "16:00", "17:00", "18:00"];

    const bookedQuery = await pool.query(
      `SELECT time_slot, end_time, resource_assigned, party_size FROM reservations 
       WHERE tenant_id = $1 AND reservation_date = $2 AND status = 'confirmed'`,
      [tenant_id, date]
    );

    const existingReservations = bookedQuery.rows;

    const availability = slots.map(slot => {
      const slotStartMins = timeToMins(slot);
      const slotEndMins = slotStartMins + slotDurationMinutes;

      const overlapping = existingReservations.filter(r => {
        const rStart = timeToMins(r.time_slot);
        const rEnd = timeToMins(r.end_time || r.time_slot);
        return slotStartMins < rEnd && slotEndMins > rStart;
      });

      const totalBooked = overlapping.reduce((acc, curr) => acc + (curr.party_size || 1), 0);
      const availableCount = Math.max(0, maxCapacity - totalBooked);

      return {
        slot,
        end_time: minsToTime(slotEndMins),
        max_capacity: maxCapacity,
        available: availableCount,
        resource_assigned: service_name || 'Pedido Estándar',
        is_full: availableCount === 0
      };
    });

    res.json({ closed: false, business_type: businessType, duration: slotDurationMinutes, availability });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/reservations', async (req, res) => {
  try {
    const { tenant_id, client_name, client_phone, reservation_date, time_slot, party_size, service_name, duration } = req.body;
    
    const tenantInfo = await pool.query('SELECT name, business_type, max_capacity, settings FROM tenants WHERE id = $1', [tenant_id]);
    if (tenantInfo.rows.length === 0) return res.status(404).json({ error: 'Negocio no encontrado' });
    
    const tenant = tenantInfo.rows[0];
    const businessType = getEffectiveBusinessType(tenant.business_type);
    const maxCapacity = tenant.max_capacity || 50;
    let settings = tenant.settings || {};
    if (typeof settings === 'string') { try { settings = JSON.parse(settings); } catch(e){} }

    const durationMins = businessType === 'bakery' ? 30 : 60;
    const startMins = timeToMins(time_slot);
    const endMins = startMins + durationMins;
    const end_time = minsToTime(endMins);
    const requestedSize = parseInt(party_size || 1);
    const booking_code = crypto.randomBytes(3).toString('hex').toUpperCase();

    const assignedResource = service_name || (businessType === 'bakery' ? 'Producto Panadería' : 'General');

    const newReservation = await pool.query(
      `INSERT INTO reservations (tenant_id, client_name, client_phone, booking_code, reservation_date, time_slot, end_time, service_name, party_size, resource_assigned) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [tenant_id, client_name, client_phone, booking_code, reservation_date, time_slot, end_time, service_name || 'General', requestedSize, assignedResource]
    );

    const createdRes = newReservation.rows[0];

    // Webhook Google Sheets
    const sheetsWebhookUrl = settings.googleSheetsWebhook || process.env.GOOGLE_SHEETS_WEBHOOK_URL;
    if (sheetsWebhookUrl) {
      try {
        await fetch(sheetsWebhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tenant_name: tenant.name, ...createdRes })
        });
      } catch (sheetErr) {
        console.error("Error al exportar a Google Sheets:", sheetErr.message);
      }
    }

    res.status(201).json({ success: true, reservation: createdRes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/reservations/lookup', async (req, res) => {
  try {
    const { client_phone, booking_code } = req.body;
    const result = await pool.query(
      `SELECT r.*, t.name as tenant_name, t.whatsapp_phone, t.slug as tenant_slug FROM reservations r 
       JOIN tenants t ON r.tenant_id = t.id 
       WHERE REPLACE(REPLACE(REPLACE(r.client_phone, ' ', ''), '+', ''), '-', '') = REPLACE(REPLACE(REPLACE($1, ' ', ''), '+', ''), '-', '')
         AND UPPER(TRIM(r.booking_code)) = UPPER(TRIM($2)) 
         AND r.status != 'cancelled'`,
      [client_phone, booking_code]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No se encontró ninguna reserva activa.' });
    }

    res.json({ success: true, reservation: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/reservations/cancel', async (req, res) => {
  try {
    const { id, client_phone, booking_code } = req.body;
    let query, params;

    if (id) {
      query = `UPDATE reservations SET status = 'cancelled' WHERE id = $1 RETURNING *`;
      params = [id];
    } else {
      query = `UPDATE reservations SET status = 'cancelled' WHERE REPLACE(REPLACE(REPLACE(client_phone, ' ', ''), '+', ''), '-', '') = REPLACE(REPLACE(REPLACE($1, ' ', ''), '+', ''), '-', '') AND UPPER(TRIM(booking_code)) = UPPER(TRIM($2)) RETURNING *`;
      params = [client_phone, booking_code];
    }

    const cancelled = await pool.query(query, params);
    if (cancelled.rows.length === 0) {
      return res.status(404).json({ error: 'Reserva no encontrada.' });
    }

    res.json({ success: true, message: "Reserva anulada correctamente." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/register', async (req, res) => {
  try {
    const { name, slug, business_type, max_capacity, whatsapp_phone, email, password } = req.body;
    const password_hash = await bcrypt.hash(password, 10);

    const defaultSettings = JSON.stringify({ shifts: [{ open: "08:00", close: "20:00" }], closedDays: [] });
    const defaultServices = ["Barra de Pan", "Croissant", "Napolitana", "Café para llevar"];

    const newTenant = await pool.query(
      `INSERT INTO tenants (name, slug, business_type, max_capacity, whatsapp_phone, email, password_hash, settings, services) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb) RETURNING id, name, slug`,
      [name, slug, business_type || 'Panadería', max_capacity || 50, whatsapp_phone, email, password_hash, defaultSettings, JSON.stringify(defaultServices)]
    );

    res.status(201).json({ success: true, tenant: newTenant.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const tenantRes = await pool.query('SELECT * FROM tenants WHERE email = $1', [email]);
    if (tenantRes.rows.length === 0) return res.status(401).json({ error: 'Credenciales inválidas' });

    const match = await bcrypt.compare(password, tenantRes.rows[0].password_hash);
    if (!match) return res.status(401).json({ error: 'Contraseña incorrecta' });

    const businesses = tenantRes.rows.map(t => ({
      tenant_id: t.id,
      name: t.name,
      slug: t.slug,
      business_type: t.business_type,
      max_capacity: t.max_capacity,
      whatsapp_phone: t.whatsapp_phone,
      settings: typeof t.settings === 'string' ? JSON.parse(t.settings) : t.settings,
      services: typeof t.services === 'string' ? JSON.parse(t.services) : t.services
    }));

    res.json({ success: true, businesses });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/reservations/:tenant_id', async (req, res) => {
  try {
    const { tenant_id } = req.params;
    const reservations = await pool.query('SELECT * FROM reservations WHERE tenant_id = $1 ORDER BY reservation_date DESC, time_slot DESC', [tenant_id]);
    res.json(reservations.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/tenant/:tenant_id', async (req, res) => {
  try {
    const { tenant_id } = req.params;
    const { name, max_capacity, whatsapp_phone, settings, services, business_type } = req.body;

    const updated = await pool.query(
      `UPDATE tenants 
       SET name = COALESCE($1, name), 
           max_capacity = COALESCE($2, max_capacity), 
           whatsapp_phone = COALESCE($3, whatsapp_phone),
           business_type = COALESCE($4, business_type),
           settings = COALESCE($5::jsonb, settings),
           services = COALESCE($6::jsonb, services)
       WHERE id = $7 RETURNING *`,
      [name, max_capacity, whatsapp_phone, business_type, settings ? JSON.stringify(settings) : null, services ? JSON.stringify(services) : null, tenant_id]
    );

    res.json({ success: true, tenant: updated.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get(/(.*)/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Servidor activo en el puerto ${PORT}`);
});
