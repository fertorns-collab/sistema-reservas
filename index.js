const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const app = express();
const PORT = 3000;

app.use(express.json());

// 1. Conexión a la base de datos (se creará el archivo reservas.db si no existe)
const db = new sqlite3.Database('./reservas.db', (err) => {
  if (err) {
    console.error('Error al conectar con SQLite:', err.message);
  } else {
    console.log('Conectado exitosamente a la base de datos SQLite.');
  }
});

// 2. Crear la tabla de reservas si aún no existe
db.run(`
  CREATE TABLE IF NOT EXISTS reservas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cliente TEXT NOT NULL,
    servicio TEXT NOT NULL,
    fecha TEXT NOT NULL,
    hora TEXT NOT NULL,
    estado TEXT DEFAULT 'confirmada'
  )
`);

// Ruta GET: Obtener todas las reservas desde la base de datos
app.get('/api/reservas', (req, res) => {
  db.all('SELECT * FROM reservas', [], (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(rows);
  });
});

// Ruta POST: Insertar una nueva reserva en la base de datos
app.post('/api/reservas', (req, res) => {
  const { cliente, servicio, fecha, hora } = req.body;
  const sql = `INSERT INTO reservas (cliente, servicio, fecha, hora) VALUES (?, ?, ?, ?)`;
  
  db.run(sql, [cliente, servicio, fecha, hora], function (err) {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.status(201).json({
      mensaje: 'Reserva guardada en la base de datos con éxito',
      id: this.lastID
    });
  });
});

app.listen(PORT, () => {
  console.log(`Servidor de reservas escuchando en http://localhost:${PORT}`);
});