import express from 'express';
import pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcrypt';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Conexión a la Base de Datos PostgreSQL
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Inicialización de la Base de Datos y datos por defecto
const initDB = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        slug VARCHAR(50) UNIQUE NOT NULL,
        business_type VARCHAR(50) NOT NULL,
        max_capacity INT DEFAULT 19,
        whatsapp_phone VARCHAR(20),
        email VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        closing_times JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS reservations (
        id SERIAL PRIMARY KEY,
        tenant_id INT REFERENCES tenants(id) ON DELETE CASCADE,
        client_name VARCHAR(100) NOT NULL,
        client_phone VARCHAR(20) NOT NULL,
        reservation_date DATE NOT NULL,
        time_slot VARCHAR(20) NOT NULL,
        party_size INT DEFAULT 1,
        status VARCHAR(20) DEFAULT 'confirmed',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Crear negocio por defecto con configuración de tramos y duración (JSONB)
    const checkTenant = await pool.query('SELECT * FROM tenants WHERE slug = $1', ['padel-club']);
    if (checkTenant.rows.length === 0) {
      const hashedPassword = await bcrypt.hash('admin123', 10);
      const defaultClosingTimes = JSON.stringify({
        slotDurationMinutes: 90, // Permite elegir tramos de 60 o 90 min
        openTime: "08:00",
        closeTime: "22:00"
      });
      await pool.query(
        `INSERT INTO tenants (name, slug, business_type, max_capacity, whatsapp_phone, email, password_hash, closing_times) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        ['Padel Club Central', 'padel-club', 'sports', 8, '34600000000', 'admin@padelclub.com', hashedPassword, defaultClosingTimes]
      );
      console.log("Negocio por defecto 'padel-club' creado con éxito.");
    }

    console.log("Tablas inicializadas correctamente.");
  } catch (err) {
    console.error("Error al inicializar la base de datos:", err.message);
  }
};
initDB();

// API: Obtener datos del negocio por slug
app.get('/api/tenant/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const tenantRes = await pool.query(
      'SELECT id, name, slug, business_type, max_capacity, whatsapp_phone, closing_times FROM tenants WHERE slug = $1', 
      [slug]
    );
    if (tenantRes.rows.length === 0) return res.status(404).json({ error: 'Negocio no encontrado' });
    res.json(tenantRes.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Login de Administrador
app.post('/api/admin/login', async (req, res) => {
  try {
    const { email, password, slug } = req.body;
    const tenantRes = await pool.query('SELECT * FROM tenants WHERE email = $1 AND slug = $2', [email, slug]);
    if (tenantRes.rows.length === 0) return res.status(401).json({ error: 'Credenciales inválidas' });

    const tenant = tenantRes.rows[0];
    const match = await bcrypt.compare(password, tenant.password_hash);
    if (!match) return res.status(401).json({ error: 'Contraseña incorrecta' });

    res.json({ success: true, tenant_id: tenant.id, name: tenant.name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Obtener reservas de un tenant (para el admin)
app.get('/api/admin/reservations/:tenant_id', async (req, res) => {
  try {
    const { tenant_id } = req.params;
    const reservations = await pool.query(
      'SELECT * FROM reservations WHERE tenant_id = $1 ORDER BY reservation_date DESC, time_slot DESC',
      [tenant_id]
    );
    res.json(reservations.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Crear reserva
app.post('/api/reservations', async (req, res) => {
  try {
    const { tenant_id, client_name, client_phone, reservation_date, time_slot, party_size } = req.body;
    
    const newReservation = await pool.query(
      `INSERT INTO reservations (tenant_id, client_name, client_phone, reservation_date, time_slot, party_size) 
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [tenant_id, client_name, client_phone, reservation_date, time_slot, party_size || 1]
    );

    res.status(201).json({ success: true, reservation: newReservation.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Anular/Cancelar reserva
app.delete('/api/reservations/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const cancelled = await pool.query(
      `UPDATE reservations SET status = 'cancelled' WHERE id = $1 RETURNING *`,
      [id]
    );

    if (cancelled.rows.length === 0) {
      return res.status(404).json({ error: 'Reserva no encontrada' });
    }

    res.json({ success: true, message: "Reserva anulada correctamente." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ruta comodín para SPA frontend
app.get(/(.*)/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Servidor SaaS activo en el puerto ${PORT}`);
});
