import express from 'express';
import pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcrypt';
import crypto from 'crypto';

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
        slug VARCHAR(50) UNIQUE NOT NULL,
        business_type VARCHAR(50) NOT NULL,
        max_capacity INT DEFAULT 10,
        whatsapp_phone VARCHAR(20),
        email VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        settings JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS reservations (
        id SERIAL PRIMARY KEY,
        tenant_id INT REFERENCES tenants(id) ON DELETE CASCADE,
        client_name VARCHAR(100) NOT NULL,
        client_phone VARCHAR(20) NOT NULL,
        booking_code VARCHAR(10) UNIQUE NOT NULL,
        reservation_date DATE NOT NULL,
        time_slot VARCHAR(50) NOT NULL,
        party_size INT DEFAULT 1,
        resource_assigned VARCHAR(50),
        status VARCHAR(20) DEFAULT 'confirmed',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      ALTER TABLE reservations ADD COLUMN IF NOT EXISTS booking_code VARCHAR(10);
      ALTER TABLE reservations ADD COLUMN IF NOT EXISTS resource_assigned VARCHAR(50);
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS settings JSONB;
    `);

    console.log("Base de datos inicializada limpia (sin datos predeterminados).");
  } catch (err) {
    console.error("Error al inicializar la base de datos:", err.message);
  }
};
initDB();

app.get('/api/tenant/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const tenantRes = await pool.query(
      'SELECT id, name, slug, business_type, max_capacity, whatsapp_phone, settings FROM tenants WHERE slug = $1', 
      [slug]
    );
    if (tenantRes.rows.length === 0) return res.status(404).json({ error: 'Negocio no encontrado' });
    res.json(tenantRes.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/reservations', async (req, res) => {
  try {
    const { tenant_id, client_name, client_phone, reservation_date, time_slot, party_size } = req.body;
    
    const booking_code = crypto.randomBytes(3).toString('hex').toUpperCase();

    const capacityCheck = await pool.query(
      `SELECT SUM(party_size) as total_booked FROM reservations 
       WHERE tenant_id = $1 AND reservation_date = $2 AND time_slot = $3 AND status = 'confirmed'`,
      [tenant_id, reservation_date, time_slot]
    );

    const tenantInfo = await pool.query('SELECT max_capacity FROM tenants WHERE id = $1', [tenant_id]);
    const maxCapacity = tenantInfo.rows[0]?.max_capacity || 10;
    const currentBooked = parseInt(capacityCheck.rows[0]?.total_booked || 0);
    const requestedSize = parseInt(party_size || 1);

    if (currentBooked + requestedSize > maxCapacity) {
      return res.status(400).json({ error: 'No hay suficiente disponibilidad o aforo para este horario.' });
    }

    const newReservation = await pool.query(
      `INSERT INTO reservations (tenant_id, client_name, client_phone, booking_code, reservation_date, time_slot, party_size) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [tenant_id, client_name, client_phone, booking_code, reservation_date, time_slot, requestedSize]
    );

    res.status(201).json({ success: true, reservation: newReservation.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/reservations/lookup', async (req, res) => {
  try {
    const { client_phone, booking_code } = req.body;
    const result = await pool.query(
      `SELECT r.*, t.name as tenant_name, t.whatsapp_phone FROM reservations r 
       JOIN tenants t ON r.tenant_id = t.id 
       WHERE r.client_phone = $1 AND r.booking_code = $2 AND r.status != 'cancelled'`,
      [client_phone, booking_code]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No se encontró ninguna reserva activa con esos datos.' });
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
      query = `UPDATE reservations SET status = 'cancelled' WHERE client_phone = $1 AND booking_code = $2 RETURNING *`;
      params = [client_phone, booking_code];
    }

    const cancelled = await pool.query(query, params);
    if (cancelled.rows.length === 0) {
      return res.status(404).json({ error: 'Reserva no encontrada o datos incorrectos.' });
    }

    res.json({ success: true, message: "Reserva anulada correctamente." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/register', async (req, res) => {
  try {
    const { name, slug, business_type, max_capacity, whatsapp_phone, email, password } = req.body;
    
    const existing = await pool.query('SELECT id FROM tenants WHERE slug = $1 OR email = $2', [slug, email]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'El identificador (slug) o el correo electrónico ya están registrados.' });
    }

    const password_hash = await bcrypt.hash(password, 10);
    const defaultSettings = JSON.stringify({
      slotDurationMinutes: 60,
      shifts: [{ open: "09:00", close: "21:00" }],
      closedDays: []
    });

    const newTenant = await pool.query(
      `INSERT INTO tenants (name, slug, business_type, max_capacity, whatsapp_phone, email, password_hash, settings) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, name, slug`,
      [name, slug, business_type, max_capacity || 10, whatsapp_phone, email, password_hash, defaultSettings]
    );

    res.status(201).json({ success: true, tenant: newTenant.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/login', async (req, res) => {
  try {
    const { email, password, slug } = req.body;
    const tenantRes = await pool.query('SELECT * FROM tenants WHERE email = $1 AND slug = $2', [email, slug]);
    if (tenantRes.rows.length === 0) return res.status(401).json({ error: 'Credenciales inválidas' });

    const tenant = tenantRes.rows[0];
    const match = await bcrypt.compare(password, tenant.password_hash);
    if (!match) return res.status(401).json({ error: 'Contraseña incorrecta' });

    res.json({ success: true, tenant_id: tenant.id, name: tenant.name, slug: tenant.slug });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/reservations/:tenant_id', async (req, res) => {
  try {
    const { tenant_id } = req.params;
    const { date, start_date, end_date } = req.query;

    let query = 'SELECT * FROM reservations WHERE tenant_id = $1';
    let params = [tenant_id];

    if (date) {
      query += ' AND reservation_date = $2';
      params.push(date);
    } else if (start_date && end_date) {
      query += ' AND reservation_date BETWEEN $2 AND $3';
      params.push(start_date, end_date);
    }

    query += ' ORDER BY reservation_date DESC, time_slot DESC';
    const reservations = await pool.query(query, params);
    res.json(reservations.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/tenant/:tenant_id', async (req, res) => {
  try {
    const { tenant_id } = req.params;
    const { name, max_capacity, whatsapp_phone, settings } = req.body;

    const updated = await pool.query(
      `UPDATE tenants 
       SET name = COALESCE($1, name), 
           max_capacity = COALESCE($2, max_capacity), 
           whatsapp_phone = COALESCE($3, whatsapp_phone),
           settings = COALESCE($4, settings)
       WHERE id = $5 RETURNING *`,
      [name, max_capacity, whatsapp_phone, settings ? JSON.stringify(settings) : null, tenant_id]
    );

    res.json({ success: true, message: "Configuración actualizada con éxito", tenant: updated.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get(/(.*)/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Servidor SaaS activo en el puerto ${PORT}`);
});
