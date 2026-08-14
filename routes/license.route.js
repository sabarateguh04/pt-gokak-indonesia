const express = require('express');
const pool = require('../db');
const { verifyLicense, countUsedSeats, totalSeats, REASON_MESSAGE } = require('../helpers/license');

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
    const result = verifyLicense();
    const payload = result.payload; // ada isinya kalau valid ATAU expired (bukan invalid/no-license)

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
    });
  } catch (e) {
    console.error('[LICENSE status]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
