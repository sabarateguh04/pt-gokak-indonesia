const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { signAdminToken, signTeknisiToken, requireAuth } = require('../middleware/auth');

const router = express.Router();

/* ═══════════════════════════════════════════════════
   Rate-limit percobaan login -- proteksi brute-force sederhana, in-
   memory (pola yang sama kayak rate-limit di routes/license.route.js).
   Key-nya IP + username (bukan IP doang) -- biar 1 IP kantor yang
   dipakai banyak orang gak saling ngeblokir gara-gara salah ketik
   punya orang lain, tapi tetap nyegah brute-force ke 1 akun spesifik.
   Reset otomatis pas login SUKSES, atau begitu window waktunya lewat.
═══════════════════════════════════════════════════ */
const LOGIN_MAX_ATTEMPTS = 8;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginAttempts = new Map(); // key -> { count, firstAttemptAt }

function loginRateLimit(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const key = `${ip}:${String(req.body?.username || '').toLowerCase()}`;
  const entry = loginAttempts.get(key);
  const now = Date.now();

  if (entry && now - entry.firstAttemptAt < LOGIN_WINDOW_MS && entry.count >= LOGIN_MAX_ATTEMPTS) {
    const minutesLeft = Math.ceil((LOGIN_WINDOW_MS - (now - entry.firstAttemptAt)) / 60000);
    return res.status(429).json({ success: false, message: `Terlalu banyak percobaan gagal. Coba lagi dalam ${minutesLeft} menit.` });
  }

  req._loginRateLimitKey = key;
  next();
}

function recordLoginFailure(key) {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now - entry.firstAttemptAt >= LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, firstAttemptAt: now });
  } else {
    entry.count += 1;
  }
}

function clearLoginFailures(key) {
  loginAttempts.delete(key);
}

/* ═══════════════════════════════════════════════════
   POST /api/auth/admin/login
   Login admin (portal dashboard)
═══════════════════════════════════════════════════ */
router.post('/admin/login', loginRateLimit, async (req, res) => {
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
      recordLoginFailure(req._loginRateLimitKey);
      return res.status(401).json({ success: false, message: 'Username atau password salah' });
    }

    const admin = rows[0];
    const match = await bcrypt.compare(password, admin.password);
    if (!match) {
      recordLoginFailure(req._loginRateLimitKey);
      return res.status(401).json({ success: false, message: 'Username atau password salah' });
    }

    clearLoginFailures(req._loginRateLimitKey);
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
router.post('/teknisi/login', loginRateLimit, async (req, res) => {
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
      recordLoginFailure(req._loginRateLimitKey);
      return res.status(401).json({ success: false, message: 'Username atau password salah' });
    }

    const teknisi = rows[0];
    const match = await bcrypt.compare(password, teknisi.password);
    if (!match) {
      recordLoginFailure(req._loginRateLimitKey);
      return res.status(401).json({ success: false, message: 'Username atau password salah' });
    }

    clearLoginFailures(req._loginRateLimitKey);
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
