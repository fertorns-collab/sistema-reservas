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

    await pool.query(`
      ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_email_key;
      DROP INDEX IF EXISTS tenants_email_key;
    `);

    await pool.query(`
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS slug VARCHAR(50);
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS business_type VARCHAR(50) DEFAULT 'general';
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS max_capacity INT DEFAULT 10;
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS whatsapp_phone VARCHAR(20);
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS settings JSONB;
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS services JSONB DEFAULT '[]';
      
      ALTER TABLE reservations ADD COLUMN IF NOT EXISTS booking_code VARCHAR(10);
      ALTER TABLE reservations ADD COLUMN IF NOT EXISTS end_time VARCHAR(50);
      ALTER TABLE reservations ADD COLUMN IF NOT EXISTS service_name VARCHAR(100);
      ALTER TABLE reservations ADD COLUMN IF NOT EXISTS resource_assigned VARCHAR(50);
      ALTER TABLE reservations ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'confirmed';
    `);

    console.log("Base de datos inicializada y migrada correctamente.");
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
    if (typeof settings === 'string') {
      try { settings = JSON.parse(settings); } catch (e) { settings = {}; }
    }

    const businessType = tenant.business_type || 'general';
    const maxCapacity = tenant.max_capacity || 10;

    // Verificar cierre por vacaciones entre dos fechas (vacationStart y vacationEnd)
    const vacationStart = settings.vacationStart;
    const vacationEnd = settings.vacationEnd;
    if (vacationStart && vacationEnd) {
      if (date >= vacationStart && date <= vacationEnd) {
        return res.json({ closed: true, message: "Negocio cerrado por vacaciones en esta fecha." });
      }
    }

    const dateObj = new Date(date + 'T00:00:00');
    const dayOfWeek = dateObj.getDay(); // 0 = Domingo, 1 = Lunes, ..., 6 = Sábado
    const closedDays = settings.closedDays || [];
    const forcedOpenDates = settings.forcedOpenDates || [];

    if (closedDays.includes(dayOfWeek) && !forcedOpenDates.includes(date)) {
      return res.json({ closed: true, message: "Negocio cerrado por día de descanso semanal." });
    }

    // Horarios específicos por día de la semana (dayShifts para 0 al 6)
    const dayShifts = settings.dayShifts || {};
    const shifts = (dayShifts[dayOfWeek] !== undefined && dayShifts[dayOfWeek] !== null && dayShifts[dayOfWeek].length > 0) 
      ? dayShifts[dayOfWeek] 
      : (settings.shifts || [{ open: "09:00", close: "21:00" }]);

    if (!shifts || shifts.length === 0) {
      return res.json({ closed: true, message: "Negocio cerrado en este día de la semana." });
    }

    let slotDurationMinutes = 60;
    if (businessType === 'court_rental') {
      slotDurationMinutes = parseInt(duration) || 60;
    } else if (businessType === 'appointment') {
      const serviceDurations = settings.serviceDurations || {};
      slotDurationMinutes = serviceDurations[service_name] || settings.slotDurationMinutes || 60;
    } else if (businessType === 'table_booking') {
      const pSize = parseInt(party_size) || 2;
      slotDurationMinutes = pSize > 4 ? (settings.durationLarge || 120) : (settings.durationStandard || 90);
    }

    let slots = [];
    shifts.forEach(shift => {
      let currentMins = timeToMins(shift.open || "09:00");
      let closeMins = timeToMins(shift.close || "21:00");

      while (currentMins + slotDurationMinutes <= closeMins) {
        slots.push(minsToTime(currentMins));
        currentMins += 30;
      }
    });

    if (slots.length === 0) {
      slots = ["09:00", "10:00", "11:00", "12:00", "13:00", "16:00", "17:00", "18:00", "19:00", "20:00"];
    }

    const bookedQuery = await pool.query(
      `SELECT time_slot, end_time, resource_assigned, party_size FROM reservations 
       WHERE tenant_id = $1 AND reservation_date = $2 AND status = 'confirmed'`,
      [tenant_id, date]
    );

    const existingReservations = bookedQuery.rows;

    const availability = slots.map(slot => {
      const slotStartMins = timeToMins(slot);
      const slotEndMins = slotStartMins + slotDurationMinutes;

      const overlappingReservations = existingReservations.filter(r => {
        const rStart = timeToMins(r.time_slot);
        const rEnd = timeToMins(r.end_time || r.time_slot);
        return slotStartMins < rEnd && slotEndMins > rStart;
      });

      let availableResourcesCount = 0;
      let assignedResource = null;

      if (businessType === 'court_rental' || businessType === 'table_booking') {
        const occupiedResources = new Set(overlappingReservations.map(r => r.resource_assigned).filter(Boolean));
        const freeCount = Math.max(0, maxCapacity - occupiedResources.size);
        
        for (let i = 1; i <= maxCapacity; i++) {
          const resName = businessType === 'court_rental' ? `Pista ${i}` : `Mesa ${i}`;
          if (!occupiedResources.has(resName)) {
            assignedResource = resName;
            break;
          }
        }
        availableResourcesCount = freeCount;
      } else {
        const totalBookedParty = overlappingReservations.reduce((acc, curr) => acc + (curr.party_size || 1), 0);
        availableResourcesCount = Math.max(0, maxCapacity - totalBookedParty);
      }

      return {
        slot,
        end_time: minsToTime(slotEndMins),
        max_capacity: maxCapacity,
        available: availableResourcesCount,
        resource_assigned: assignedResource,
        is_full: availableResourcesCount === 0
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
    
    const tenantInfo = await pool.query('SELECT business_type, max_capacity, settings FROM tenants WHERE id = $1', [tenant_id]);
    if (tenantInfo.rows.length === 0) return res.status(404).json({ error: 'Negocio no encontrado' });
    
    const tenant = tenantInfo.rows[0];
    const businessType = tenant.business_type || 'general';
    const maxCapacity = tenant.max_capacity || 10;
    let settings = tenant.settings || {};
    if (typeof settings === 'string') { try { settings = JSON.parse(settings); } catch(e){} }

    let durationMins = 60;
    if (businessType === 'court_rental') {
      durationMins = parseInt(duration) || 60;
    } else if (businessType === 'appointment') {
      const serviceDurations = settings.serviceDurations || {};
      durationMins = serviceDurations[service_name] || 60;
    } else if (businessType === 'table_booking') {
      const pSize = parseInt(party_size) || 2;
      durationMins = pSize > 4 ? (settings.durationLarge || 120) : (settings.durationStandard || 90);
    }

    const startMins = timeToMins(time_slot);
    const endMins = startMins + durationMins;
    const end_time = minsToTime(endMins);
    const requestedSize = parseInt(party_size || 1);
    const booking_code = crypto.randomBytes(3).toString('hex').toUpperCase();

    const bookedQuery = await pool.query(
      `SELECT time_slot, end_time, resource_assigned, party_size FROM reservations 
       WHERE tenant_id = $1 AND reservation_date = $2 AND status = 'confirmed'`,
      [tenant_id, reservation_date]
    );

    const existing = bookedQuery.rows;
    const overlapping = existing.filter(r => {
      const rStart = timeToMins(r.time_slot);
      const rEnd = timeToMins(r.end_time || r.time_slot);
      return startMins < rEnd && endMins > rStart;
    });

    let assignedResource = 'General';

    if (businessType === 'court_rental' || businessType === 'table_booking') {
      const occupiedResources = new Set(overlapping.map(r => r.resource_assigned).filter(Boolean));
      if (occupiedResources.size >= maxCapacity) {
        return res.status(400).json({ error: 'No hay pistas o mesas libres para este intervalo de tiempo.' });
      }
      for (let i = 1; i <= maxCapacity; i++) {
        const resName = businessType === 'court_rental' ? `Pista ${i}` : `Mesa ${i}`;
        if (!occupiedResources.has(resName)) {
          assignedResource = resName;
          break;
        }
      }
    } else {
      const totalBooked = overlapping.reduce((acc, curr) => acc + (curr.party_size || 1), 0);
      if (totalBooked + requestedSize > maxCapacity) {
        return res.status(400).json({ error: 'No hay suficiente aforo disponible para este horario.' });
      }
    }

    const newReservation = await pool.query(
      `INSERT INTO reservations (tenant_id, client_name, client_phone, booking_code, reservation_date, time_slot, end_time, service_name, party_size, resource_assigned) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [tenant_id, client_name, client_phone, booking_code, reservation_date, time_slot, end_time, service_name || 'General', requestedSize, assignedResource]
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
      `SELECT r.*, t.name as tenant_name, t.whatsapp_phone, t.slug as tenant_slug FROM reservations r 
       JOIN tenants t ON r.tenant_id = t.id 
       WHERE UPPER(TRIM(r.client_phone)) = UPPER(TRIM($1)) 
         AND UPPER(TRIM(r.booking_code)) = UPPER(TRIM($2)) 
         AND r.status != 'cancelled'`,
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
      query = `UPDATE reservations SET status = 'cancelled' WHERE UPPER(TRIM(client_phone)) = UPPER(TRIM($1)) AND UPPER(TRIM(booking_code)) = UPPER(TRIM($2)) RETURNING *`;
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

app.put('/api/reservations/update', async (req, res) => {
  try {
    const { id, client_phone, booking_code, reservation_date, time_slot, party_size, service_name } = req.body;
    
    const updated = await pool.query(
      `UPDATE reservations 
       SET reservation_date = COALESCE($1, reservation_date),
           time_slot = COALESCE($2, time_slot),
           party_size = COALESCE($3, party_size),
           service_name = COALESCE($4, service_name)
       WHERE id = $5 AND client_phone = $6 AND booking_code = $7 RETURNING *`,
      [reservation_date, time_slot, party_size, service_name, id, client_phone, booking_code]
    );

    if (updated.rows.length === 0) {
      return res.status(404).json({ error: 'No se pudo actualizar la reserva. Verifique los datos.' });
    }

    res.json({ success: true, message: "Reserva modificada correctamente", reservation: updated.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/register', async (req, res) => {
  try {
    const { name, slug, business_type, max_capacity, whatsapp_phone, email, password } = req.body;
    
    const existing = await pool.query('SELECT id FROM tenants WHERE slug = $1', [slug]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'El identificador (slug) ya está registrado. Elige otro.' });
    }

    const userExists = await pool.query('SELECT password_hash FROM tenants WHERE email = $1 LIMIT 1', [email]);
    let password_hash;
    if (userExists.rows.length > 0) {
      password_hash = userExists.rows[0].password_hash;
    } else {
      password_hash = await bcrypt.hash(password, 10);
    }

    const defaultSettings = JSON.stringify({
      shifts: [{ open: "09:00", close: "22:00" }],
      dayShifts: {},
      closedDays: [],
      vacationStart: "",
      vacationEnd: "",
      slotDurationMinutes: 60,
      serviceDurations: { "Corte": 30, "Tinte": 60, "Manicura": 45 },
      durationStandard: 90,
      durationLarge: 120
    });

    const defaultServices = business_type === 'appointment' ? ["Corte", "Tinte", "Manicura"] : (business_type === 'court_rental' ? ["Pádel 60 min", "Pádel 90 min"] : ["General"]);

    const newTenant = await pool.query(
      `INSERT INTO tenants (name, slug, business_type, max_capacity, whatsapp_phone, email, password_hash, settings, services) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb) RETURNING id, name, slug`,
      [name, slug, business_type || 'general', max_capacity || 10, whatsapp_phone, email, password_hash, defaultSettings, JSON.stringify(defaultServices)]
    );

    res.status(201).json({ success: true, tenant: newTenant.rows[0] });
  } catch (err) {
    console.error("Error al registrar negocio:", err.message);
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

    const businesses = tenantRes.rows.map(t => {
      let s = t.services;
      if (typeof s === 'string') { try { s = JSON.parse(s); } catch(e) { s = ['General']; } }
      let set = t.settings;
      if (typeof set === 'string') { try { set = JSON.parse(set); } catch(e) { set = {}; } }

      return {
        tenant_id: t.id,
        name: t.name,
        slug: t.slug,
        business_type: t.business_type,
        max_capacity: t.max_capacity,
        whatsapp_phone: t.whatsapp_phone,
        settings: set,
        services: s
      };
    });

    res.json({ success: true, businesses });
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
      [
        name, 
        max_capacity, 
        whatsapp_phone, 
        business_type,
        settings ? JSON.stringify(settings) : null, 
        services ? JSON.stringify(services) : null,
        tenant_id
      ]
    );

    let tenant = updated.rows[0];
    if (typeof tenant.services === 'string') { try { tenant.services = JSON.parse(tenant.services); } catch(e){} }
    if (typeof tenant.settings === 'string') { try { tenant.settings = JSON.parse(tenant.settings); } catch(e){} }

    res.json({ success: true, message: "Configuración actualizada con éxito", tenant });
  } catch (err) {
    console.error("Error al actualizar negocio:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get(/(.*)/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Servidor SaaS activo en el puerto ${PORT}`);
});
