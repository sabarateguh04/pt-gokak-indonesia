const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { signAdminToken, signTeknisiToken, requireAuth } = require('../middleware/auth');

const router = express.Router();

/* ═══════════════════════════════════════════════════
   POST /api/auth/admin/login
   Login admin (portal dashboard)
═══════════════════════════════════════════════════ */
router.post('/admin/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'username & password wajib diisi' });
  }

  try {
    const [rows] = await pool.query(
      `SELECT id, username, password, nama, role FROM pt_kapuk_admins WHERE username = ? AND is_active = 1 LIMIT 1`,
      [username],
    );
    if (rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Username atau password salah' });
    }

    const admin = rows[0];
    const match = await bcrypt.compare(password, admin.password);
    if (!match) {
      return res.status(401).json({ success: false, message: 'Username atau password salah' });
    }

    const token = signAdminToken(admin);

    return res.json({
      success: true,
      token,
      adminId: admin.id,
      username: admin.username,
      nama: admin.nama,
      role: admin.role,
    });
  } catch (e) {
    console.error('[AUTH admin/login]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ═══════════════════════════════════════════════════
   POST /api/auth/teknisi/login
   Login teknisi/karyawan (portal terpisah dari admin)
═══════════════════════════════════════════════════ */
router.post('/teknisi/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'username & password wajib diisi' });
  }

  try {
    const [rows] = await pool.query(
      `SELECT id, username, password, nama, no_hp, email, status
       FROM pt_kapuk_teknisi WHERE username = ? AND is_active = 1 LIMIT 1`,
      [username],
    );
    if (rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Username atau password salah' });
    }

    const teknisi = rows[0];
    const match = await bcrypt.compare(password, teknisi.password);
    if (!match) {
      return res.status(401).json({ success: false, message: 'Username atau password salah' });
    }

    const token = signTeknisiToken(teknisi);

    return res.json({
      success: true,
      token,
      teknisiId: teknisi.id,
      username: teknisi.username,
      nama: teknisi.nama,
      status: teknisi.status,
    });
  } catch (e) {
    console.error('[AUTH teknisi/login]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ═══════════════════════════════════════════════════
   GET /api/auth/me
   Dipakai frontend buat verifikasi token masih valid + ambil profil dasar
═══════════════════════════════════════════════════ */
router.get('/me', requireAuth, async (req, res) => {
  return res.json({ success: true, user: req.user });
});

module.exports = router;
