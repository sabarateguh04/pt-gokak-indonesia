const { verifyLicense, REASON_MESSAGE } = require('../helpers/license');

/**
 * Dipasang di server.js SEBELUM semua route /api/* (kecuali /api/license
 * & /health, yang harus tetap kejawab walau lisensi expired -- biar
 * admin masih bisa LIAT KENAPA dia kelock, bukan cuma dapet error kosong).
 * Kalau lisensi invalid/expired, SEMUA endpoint lain (termasuk login)
 * ditolak dari sini -- jadi begitu lisensi abis, gak ada jalan pintas
 * lewat token JWT lama yang masih berlaku.
 */
function requireValidLicense(req, res, next) {
  const result = verifyLicense();
  if (!result.valid) {
    return res.status(403).json({
      success: false,
      licenseError: result.reason,
      message: REASON_MESSAGE[result.reason] || 'Lisensi tidak valid.',
    });
  }
  req.license = result.payload;
  next();
}

module.exports = { requireValidLicense };
