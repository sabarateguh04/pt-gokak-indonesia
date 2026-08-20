const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { emitToDashboard } = require('../socket');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { classifyPoint } = require('../helpers/geo');

// Cache primary areas dari pt_gokak_lines (refresh setiap 60 detik)
let _areasCache = null;
let _areasCacheAt = 0;
async function getPrimaryLinesCached() {
  if (_areasCache && Date.now() - _areasCacheAt < 60_000) return _areasCache;
  const [rows] = await pool.query(
    `SELECT id, polygon FROM pt_gokak_lines WHERE is_primary = 1 AND is_active = 1`
  );
  _areasCache = rows;
  _areasCacheAt = Date.now();
  return _areasCache;
}

const router = express.Router();

router.use(requireAuth);

/* ═══════════════════════════════════════════════════
   POST /api/users/:id/status
   Update status kerja (OFFLINE / ONLINE / ON_TASK)
═══════════════════════════════════════════════════ */
router.post('/:id/status', async (req, res) => {
  const { status } = req.body;
  if (!['OFFLINE', 'ONLINE', 'ON_TASK'].includes(status)) {
    return res.status(400).json({ success: false, message: 'status tidak valid' });
  }
  if (Number(req.user.id) !== Number(req.params.id) && req.user.role !== 'ADMIN') {
    return res.status(403).json({ success: false, message: 'Tidak boleh ubah status pengguna lain' });
  }
  try {
    await pool.query(`UPDATE pt_gokak_users SET status = ? WHERE id = ?`, [status, req.params.id]);
    emitToDashboard('teknisi-status', { teknisiId: Number(req.params.id), status });
    return res.json({ success: true, message: `Status diubah ke ${status}` });
  } catch (e) {
    console.error('[USER status]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ═══════════════════════════════════════════════════
   POST /api/users/:id/location
   GPS ping berkala selama status ONLINE/ON_TASK.
═══════════════════════════════════════════════════ */
router.post('/:id/location', async (req, res) => {
  const { latitude, longitude, taskId } = req.body;
  if (latitude === undefined || longitude === undefined) {
    return res.status(400).json({ success: false, message: 'latitude & longitude wajib diisi' });
  }
  if (Number(req.user.id) !== Number(req.params.id)) {
    return res.status(403).json({ success: false, message: 'Tidak boleh kirim lokasi atas nama pengguna lain' });
  }

  try {
    const [rows] = await pool.query(`SELECT status, line_id FROM pt_gokak_users WHERE id = ?`, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Pengguna tidak ditemukan' });

    if (rows[0].status === 'OFFLINE') {
      return res.status(409).json({
        success: false,
        message: 'Berstatus OFFLINE — set status ke ONLINE dulu sebelum kirim lokasi',
      });
    }

    // Classify point terhadap primary lines (area pabrik) dari database
    const primaryAreas = await getPrimaryLinesCached();
    const { inArea, areaId } = classifyPoint(Number(longitude), Number(latitude), primaryAreas);

    const now = new Date();
    await pool.query(
      `UPDATE pt_gokak_users SET latitude=?, longitude=?, last_location_at=? WHERE id=?`,
      [latitude, longitude, now, req.params.id],
    );
    await pool.query(
      `INSERT INTO pt_gokak_user_locations (user_id, task_id, latitude, longitude, in_line, line_id, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [req.params.id, taskId || null, latitude, longitude, inArea ? 1 : 0, rows[0].line_id || null, now],
    );

    emitToDashboard('teknisi-location', {
      teknisiId: Number(req.params.id), latitude, longitude, tiketId: taskId || null, recordedAt: now, inArea,
    });

    return res.json({ success: true });
  } catch (e) {
    console.error('[USER location]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* GET /api/users  — daftar semua user (admin only) */
router.get('/', requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.id, u.username, u.nama, u.no_hp, u.email, u.role, u.line_id,
              u.status, u.is_active, u.created_at,
              l.nama AS line_nama
       FROM pt_gokak_users u
       LEFT JOIN pt_gokak_lines l ON l.id = u.line_id
       ORDER BY u.nama ASC`
    );
    return res.json({ success: true, data: rows });
  } catch (e) {
    console.error('[USER list]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ═══════════════════════════════════════════════════
   PUT /api/users/profile (Update Profile Sendiri)
═══════════════════════════════════════════════════ */
router.put('/profile', async (req, res) => {
  const { nama, email, password } = req.body;
  try {
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      await pool.query(
        `UPDATE pt_gokak_users SET nama=?, email=?, password=? WHERE id=?`,
        [nama, email || null, hash, req.user.id]
      );
    } else {
      await pool.query(
        `UPDATE pt_gokak_users SET nama=?, email=? WHERE id=?`,
        [nama, email || null, req.user.id]
      );
    }
    res.json({ success: true, message: 'Profil berhasil diperbarui' });
  } catch (e) {
    console.error('[USER update profile]', e.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* GET /api/users/:id (Detail User) */
router.get('/:id', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, username, nama, role, is_active, line_id, email, no_hp FROM pt_gokak_users WHERE id = ?`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'User tidak ditemukan' });
    return res.json({ success: true, user: rows[0] });
  } catch (e) {
    console.error('[USER detail]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* POST /api/users (Create User) */
router.post('/', requireAdmin, async (req, res) => {
  const { username, password, nama, role, line_id } = req.body;
  if (!username || !password || !nama || !role) {
    return res.status(400).json({ success: false, message: 'Semua field wajib diisi' });
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    const [result] = await pool.query(
      `INSERT INTO pt_gokak_users (username, password, nama, role, line_id) VALUES (?, ?, ?, ?, ?)`,
      [username, hash, nama, role, line_id || null]
    );
    res.json({ success: true, id: result.insertId });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ success: false, message: 'Username sudah terpakai' });
    }
    console.error('[USER create]', e.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* PUT /api/users/:id (Update User) */
router.put('/:id', requireAdmin, async (req, res) => {
  const { username, password, nama, role, line_id } = req.body;
  try {
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      await pool.query(
        `UPDATE pt_gokak_users SET username=?, password=?, nama=?, role=?, line_id=? WHERE id=?`,
        [username, hash, nama, role, line_id || null, req.params.id]
      );
    } else {
      await pool.query(
        `UPDATE pt_gokak_users SET username=?, nama=?, role=?, line_id=? WHERE id=?`,
        [username, nama, role, line_id || null, req.params.id]
      );
    }
    res.json({ success: true });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ success: false, message: 'Username sudah terpakai' });
    }
    console.error('[USER update]', e.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* DELETE /api/users/:id (Soft Delete) */
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query(`UPDATE pt_gokak_users SET is_active = 0 WHERE id=?`, [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    console.error('[USER delete]', e.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
