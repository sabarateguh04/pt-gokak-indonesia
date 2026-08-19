const express = require('express');
const pool = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// Semua rute master hanya bisa diakses oleh ADMIN
router.use(requireAuth);
router.use(requireAdmin);

// ───────────────────────────────────────────────────────────
// 1. LINES / AREA
// ───────────────────────────────────────────────────────────
router.get('/lines', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM pt_gokak_lines ORDER BY nama ASC');
    res.json({ success: true, data: rows });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.post('/lines', async (req, res) => {
  const { nama, departemen, deskripsi, polygon } = req.body;
  try {
    const [result] = await pool.query(
      `INSERT INTO pt_gokak_lines (nama, departemen, deskripsi, polygon) VALUES (?, ?, ?, ?)`,
      [nama, departemen, deskripsi, JSON.stringify(polygon || [])]
    );
    res.json({ success: true, id: result.insertId });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.put('/lines/:id', async (req, res) => {
  const { nama, departemen, deskripsi, polygon } = req.body;
  try {
    await pool.query(
      `UPDATE pt_gokak_lines SET nama=?, departemen=?, deskripsi=?, polygon=? WHERE id=?`,
      [nama, departemen, deskripsi, JSON.stringify(polygon || []), req.params.id]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.delete('/lines/:id', async (req, res) => {
  try {
    // Soft delete
    await pool.query(`UPDATE pt_gokak_lines SET is_active = 0 WHERE id=?`, [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ───────────────────────────────────────────────────────────
// 2. SHIFTS
// ───────────────────────────────────────────────────────────
router.get('/shifts', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM pt_gokak_shifts ORDER BY start_time ASC');
    res.json({ success: true, data: rows });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.post('/shifts', async (req, res) => {
  const { nama, start_time, end_time } = req.body;
  try {
    const [result] = await pool.query(
      `INSERT INTO pt_gokak_shifts (nama, start_time, end_time) VALUES (?, ?, ?)`,
      [nama, start_time, end_time]
    );
    res.json({ success: true, id: result.insertId });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.put('/shifts/:id', async (req, res) => {
  const { nama, start_time, end_time } = req.body;
  try {
    await pool.query(
      `UPDATE pt_gokak_shifts SET nama=?, start_time=?, end_time=? WHERE id=?`,
      [nama, start_time, end_time, req.params.id]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.delete('/shifts/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM pt_gokak_shifts WHERE id=?`, [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ───────────────────────────────────────────────────────────
// 3. MACHINES
// ───────────────────────────────────────────────────────────
router.get('/machines', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT m.*, l.nama as line_nama 
       FROM pt_gokak_machines m 
       LEFT JOIN pt_gokak_lines l ON m.line_id = l.id 
       ORDER BY m.kode ASC`
    );
    res.json({ success: true, data: rows });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.post('/machines', async (req, res) => {
  const { kode, nama, tipe, line_id } = req.body;
  try {
    const [result] = await pool.query(
      `INSERT INTO pt_gokak_machines (kode, nama, tipe, line_id) VALUES (?, ?, ?, ?)`,
      [kode, nama, tipe, line_id || null]
    );
    res.json({ success: true, id: result.insertId });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.put('/machines/:id', async (req, res) => {
  const { kode, nama, tipe, line_id } = req.body;
  try {
    await pool.query(
      `UPDATE pt_gokak_machines SET kode=?, nama=?, tipe=?, line_id=? WHERE id=?`,
      [kode, nama, tipe, line_id || null, req.params.id]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.delete('/machines/:id', async (req, res) => {
  try {
    // Soft delete
    await pool.query(`UPDATE pt_gokak_machines SET is_active = 0 WHERE id=?`, [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ───────────────────────────────────────────────────────────
// 4. TASK CATEGORIES
// ───────────────────────────────────────────────────────────
router.get('/task-categories', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM pt_gokak_task_categories ORDER BY nama ASC');
    res.json({ success: true, data: rows });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.post('/task-categories', async (req, res) => {
  const { nama, deskripsi } = req.body;
  try {
    const [result] = await pool.query(
      `INSERT INTO pt_gokak_task_categories (nama, deskripsi) VALUES (?, ?)`,
      [nama, deskripsi]
    );
    res.json({ success: true, id: result.insertId });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.put('/task-categories/:id', async (req, res) => {
  const { nama, deskripsi } = req.body;
  try {
    await pool.query(
      `UPDATE pt_gokak_task_categories SET nama=?, deskripsi=? WHERE id=?`,
      [nama, deskripsi, req.params.id]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.delete('/task-categories/:id', async (req, res) => {
  try {
    // Hard delete is fine for categories if not used, otherwise handle FK constraints
    await pool.query(`DELETE FROM pt_gokak_task_categories WHERE id=?`, [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    // If foreign key constraint fails, send friendly error
    if(e.code === 'ER_ROW_IS_REFERENCED_2') {
      return res.status(400).json({ success: false, message: 'Kategori ini sedang digunakan oleh Tugas. Tidak dapat dihapus.' });
    }
    res.status(500).json({ success: false, message: e.message });
  }
});

// ───────────────────────────────────────────────────────────
// 5. PM PARAMETERS
// ───────────────────────────────────────────────────────────
router.get('/pm-parameters', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM pt_gokak_pm_parameters ORDER BY machine_tipe ASC');
    res.json({ success: true, data: rows });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ───────────────────────────────────────────────────────────
// 6. USERS (Mekanik & Leader untuk dropdown)
// ───────────────────────────────────────────────────────────
router.get('/users', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.id, u.username, u.nama, u.role, u.line_id, l.nama as line_nama 
       FROM pt_gokak_users u 
       LEFT JOIN pt_gokak_lines l ON u.line_id = l.id 
       WHERE u.is_active = 1 
       ORDER BY u.role, u.nama ASC`
    );
    res.json({ success: true, data: rows });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
