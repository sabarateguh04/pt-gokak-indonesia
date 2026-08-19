const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { signUserToken, requireAuth } = require('../middleware/auth');

const router = express.Router();

/* ═══════════════════════════════════════════════════
   Rate-limit percobaan login -- proteksi brute-force
═══════════════════════════════════════════════════ */
const LOGIN_MAX_ATTEMPTS = 8;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginAttempts = new Map();

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
   POST /api/auth/login
   Unified login untuk semua role (ADMIN, LEADER, MEKANIK, EXECUTIVE)
═══════════════════════════════════════════════════ */
router.post('/login', loginRateLimit, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Username & password wajib diisi' });
  }

  try {
    const [rows] = await pool.query(
      `SELECT id, username, password, nama, role, line_id, status 
       FROM pt_gokak_users WHERE username = ? AND is_active = 1 LIMIT 1`,
      [username]
    );
    
    if (rows.length === 0) {
      recordLoginFailure(req._loginRateLimitKey);
      return res.status(401).json({ success: false, message: 'Username atau password salah' });
    }

    const user = rows[0];
    const match = await bcrypt.compare(password, user.password);
    
    if (!match) {
      recordLoginFailure(req._loginRateLimitKey);
      return res.status(401).json({ success: false, message: 'Username atau password salah' });
    }

    clearLoginFailures(req._loginRateLimitKey);
    const token = signUserToken(user);

    return res.json({
      success: true,
      token,
      user: {
        id: user.id,
        username: user.username,
        nama: user.nama,
        role: user.role,
        line_id: user.line_id,
        status: user.status
      }
    });
  } catch (e) {
    console.error('[AUTH login]', e.message);
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
