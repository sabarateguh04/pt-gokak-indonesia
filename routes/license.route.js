const express = require('express');
const pool = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { verifyLicenseFull, activateLicense, countUsedSeats, totalSeats, REASON_MESSAGE, APP_VERSION } = require('../helpers/license');

const router = express.Router();

/* ═══════════════════════════════════════════════════
   GET /api/license/status
   SENGAJA PUBLIK (gak lewat requireAuth ATAU requireValidLicense) --
   ini yang dipanggil frontend buat nunjukin banner/halaman "lisensi
   habis" ke admin, jadi harus tetap kejawab WALAUPUN lisensinya lagi
   invalid/expired (justru itu skenario utamanya). Info yang dibalikin
   sengaja dibikin gak terlalu sensitif (gak expose isi token mentah).
═══════════════════════════════════════════════════ */
router.get('/status', async (req, res) => {
  try {
    const result = await verifyLicenseFull(pool);
    const payload = result.payload; // ada isinya kalau valid ATAU expired (bukan invalid/no-license/clock-tampered)

    let seatsUsed = null;
    if (payload) {
      try { seatsUsed = await countUsedSeats(pool); } catch (e) { /* biarin null kalau DB lagi bermasalah */ }
    }

    const validUntil = payload?.exp ? new Date(payload.exp * 1000) : null;
    const daysRemaining = validUntil ? Math.ceil((validUntil.getTime() - Date.now()) / (1000 * 60 * 60 * 24)) : null;

    return res.json({
      success: true,
      valid: result.valid,
      reason: result.reason,
      message: result.valid ? null : (REASON_MESSAGE[result.reason] || 'Lisensi tidak valid.'),
      customer: payload?.customer || null,
      valid_until: validUntil,
      days_remaining: daysRemaining,
      seats_used: seatsUsed,
      seats_total: payload ? totalSeats(payload) : null,
      app_version: APP_VERSION,
    });
  } catch (e) {
    console.error('[LICENSE status]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ═══════════════════════════════════════════════════
   POST /api/license/request
   Ajukan tambah seat / perpanjangan / lainnya -- SENGAJA PUBLIK juga
   (gak butuh login), soalnya justru skenario yang paling penting itu
   PAS lagi kekunci (expired) admin gak bisa login sama sekali, tapi
   tetap harus bisa ngajuin perpanjangan dari halaman /license-locked.
   Rate-limit sederhana di memori (1x / 5 menit / IP) biar gak gampang
   di-spam karena publik.
═══════════════════════════════════════════════════ */
const RATE_LIMIT_MS = 5 * 60 * 1000;
const lastRequestByIp = new Map();

router.post('/request', async (req, res) => {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const last = lastRequestByIp.get(ip) || 0;
  if (Date.now() - last < RATE_LIMIT_MS) {
    return res.status(429).json({ success: false, message: 'Terlalu sering. Coba lagi beberapa menit lagi.' });
  }

  const { type, requested_seats, note, contact_name, contact_email } = req.body;
  const validType = ['ADDON', 'RENEWAL', 'OTHER'].includes(type) ? type : 'ADDON';

  try {
    const [result] = await pool.query(
      `INSERT INTO pt_gokak_license_requests (type, requested_seats, note, contact_name, contact_email)
       VALUES (?, ?, ?, ?, ?)`,
      [validType, requested_seats || null, note || null, contact_name || null, contact_email || null],
    );
    lastRequestByIp.set(ip, Date.now());

    // Kirim ke vendor lewat webhook kalau dikonfigurasi -- GAGAL DI SINI
    // GAK BOLEH bikin request-nya ilang, udah kesimpen di DB di atas
    // sebagai jaring pengaman (baris ini cuma "bonus" biar kita cepet tau).
    let webhookSent = false;
    const webhookUrl = process.env.VENDOR_REQUEST_WEBHOOK_URL;
    if (webhookUrl) {
      try {
        const currentLicense = await verifyLicenseFull(pool);
        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            request_id: result.insertId,
            type: validType,
            requested_seats: requested_seats || null,
            note: note || null,
            contact_name: contact_name || null,
            contact_email: contact_email || null,
            current_customer: currentLicense.payload?.customer || '(lisensi tidak terbaca)',
            current_seats: currentLicense.payload ? totalSeats(currentLicense.payload) : null,
          }),
        });
        webhookSent = true;
        await pool.query(`UPDATE pt_gokak_license_requests SET webhook_sent = 1 WHERE id = ?`, [result.insertId]);
      } catch (e) {
        console.error('[LICENSE request webhook]', e.message);
      }
    }

    return res.json({
      success: true,
      requestId: result.insertId,
      webhookSent,
      // Kalau webhook gak dikonfigurasi/gagal, frontend tampilin ini
      // sebagai jalur cadangan (kirim email manual ke vendor).
      fallbackContactEmail: process.env.VENDOR_SUPPORT_EMAIL || null,
      message: webhookSent
        ? 'Pengajuan terkirim ke vendor. Kami akan menghubungi Anda segera.'
        : 'Pengajuan tersimpan. Kalau gak ada balasan dalam 1x24 jam, hubungi vendor langsung.',
    });
  } catch (e) {
    console.error('[LICENSE request]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* GET /api/license/requests — riwayat pengajuan, buat admin lihat di
   halaman Lisensi. Ini BUTUH login (beda sama /status & /request di
   atas) -- data kontak orang gak sebebas itu, dan ini gak krusial buat
   diakses pas lagi kekunci (beda kasus sama ngajuin request baru). */
router.get('/requests', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, type, requested_seats, note, contact_name, contact_email, webhook_sent, created_at
       FROM pt_gokak_license_requests ORDER BY created_at DESC LIMIT 50`,
    );
    return res.json({ success: true, requests: rows });
  } catch (e) {
    console.error('[LICENSE requests]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ═══════════════════════════════════════════════════
   POST /api/license/activate
   Admin tempel token BARU (dikirim vendor lewat email/chat) langsung
   dari dashboard -- gak perlu akses SSH/file server sama sekali. BUTUH
   LOGIN ADMIN (requireAuth + requireAdmin), TAPI SENGAJA didaftarin di
   sini (sebelum gerbang requireValidLicense di server.js), soalnya
   justru skenario utamanya itu lisensi lagi INVALID -- endpoint ini
   yang jadi jalan keluarnya. Login sendiri juga udah dipindah ke
   SEBELUM gerbang lisensi (lihat server.js) supaya admin tetap bisa
   login walau lisensinya lagi mati, terus dari sini pasang yang baru.
═══════════════════════════════════════════════════ */
router.post('/activate', requireAuth, requireAdmin, async (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string' || token.trim().length < 20) {
    return res.status(400).json({ success: false, message: 'Token lisensi wajib diisi (salin lengkap dari vendor).' });
  }

  try {
    const result = activateLicense(token.trim());
    if (!result.success) {
      const message = result.reason === 'ID_MITRA_MISMATCH'
        ? REASON_MESSAGE.ID_MITRA_MISMATCH
        : 'Token lisensi tidak valid atau rusak. Pastikan disalin lengkap tanpa terpotong, lalu coba lagi.';
      return res.status(400).json({ success: false, message });
    }

    const full = await verifyLicenseFull(pool);
    return res.json({
      success: true,
      valid: full.valid,
      reason: full.reason,
      message: full.valid
        ? 'Lisensi berhasil diaktifkan. Semua fitur sudah terbuka kembali.'
        : `Token tersimpan, tapi lisensi masih belum aktif: ${REASON_MESSAGE[full.reason] || full.reason}`,
    });
  } catch (e) {
    console.error('[LICENSE activate]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
