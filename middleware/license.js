const pool = require('../db');
const { verifyLicenseFull, REASON_MESSAGE } = require('../helpers/license');

/**
 * Dipasang di server.js SEBELUM semua route /api/* (kecuali /api/license
 * & /health, yang harus tetap kejawab walau lisensi expired -- biar
 * admin masih bisa LIAT KENAPA dia kelock, bukan cuma dapet error kosong).
 * Kalau lisensi invalid/expired/jam sistemnya dimundurin, SEMUA endpoint
 * lain (termasuk login) ditolak dari sini -- jadi begitu lisensi abis,
 * gak ada jalan pintas lewat token JWT lama yang masih berlaku.
 *
 * KECUALI kalau VENDOR_MASTER_MODE=true (instalasi master vendor
 * sendiri, lihat server.js & notesubscribe.md bagian 10-I) -- gerbang
 * ini DILEWATIN TOTAL, gak peduli lisensi lokalnya valid/expired/gak
 * ada sama sekali. Alasannya: instalasi master itu BUKAN instalasi
 * customer, dia yang justru NERBITIN lisensi buat customer lain --
 * mustahil (dan gak masuk akal) vendor kekunci dari alat kerjanya
 * sendiri gara-gara lisensi contoh di dev-nya kebetulan kadaluarsa.
 * Halaman/menu Lisensi TETAP ada & tetap bisa dibuka normal di sini
 * (endpoint-nya emang selalu di luar gerbang ini, lihat server.js) --
 * cuma GERBANGNYA yang gak pernah nge-block apa pun di instalasi ini.
 */
async function requireValidLicense(req, res, next) {
  if (process.env.VENDOR_MASTER_MODE === 'true') return next();

  const result = await verifyLicenseFull(pool);
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
