/* Verifikasi license key (JWT ditandatangani RS256 -- lihat
 * licensing-tools/generate-license.js buat cara bikinnya).
 *
 * Public key di sini AMAN buat ke-ship ke customer (cuma bisa buat
 * VERIFIKASI tanda tangan, gak bisa buat bikin license baru). Yang
 * gak boleh pernah ikut ke-ship itu licensing-tools/keys/license-
 * private.pem -- itu cuma dipakai di mesin vendor buat generate token.
 *
 * License key-nya sendiri dibaca dari FILE `license.lic` di root
 * project (bukan cuma env var) -- sengaja gitu biar PERPANJANG/NAMBAH
 * ADD-ON gak perlu restart service, cukup timpa file itu + tunggu
 * cache-nya refresh (lihat CACHE_TTL_MS). Fallback ke env LICENSE_KEY
 * kalau file-nya gak ada (praktis buat testing/dev).
 */
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');

const PUBLIC_KEY_PATH = path.join(__dirname, '..', 'config', 'license-public.pem');
const LICENSE_FILE_PATH = process.env.LICENSE_FILE || path.join(__dirname, '..', 'license.lic');
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 menit -- lisensi baru kepake tanpa restart, gak query/baca file tiap request

// Seat DIHITUNG DARI TEKNISI AKTIF SAJA, bukan admin -- lihat asumsi
// bisnis di notesubscribe.md bagian 3. Kalau nanti admin juga mau
// dihitung, tinggal ubah query di countUsedSeats().
async function countUsedSeats(pool) {
  const [[row]] = await pool.query(`SELECT COUNT(*) AS n FROM pt_kapuk_teknisi WHERE is_active = 1`);
  return row.n;
}

let publicKey = null;
try {
  publicKey = fs.readFileSync(PUBLIC_KEY_PATH, 'utf8');
} catch (e) {
  console.error('[LICENSE] ⚠️  Public key gak ketemu di', PUBLIC_KEY_PATH, '-- semua akses bakal diblokir sampai ini dibenerin.');
}

function readLicenseToken() {
  try {
    return fs.readFileSync(LICENSE_FILE_PATH, 'utf8').trim();
  } catch (e) {
    return process.env.LICENSE_KEY ? process.env.LICENSE_KEY.trim() : null;
  }
}

/** Verifikasi mentah, tanpa cache -- dipanggil lewat verifyLicense() di bawah. */
function verifyLicenseRaw() {
  if (!publicKey) {
    return { valid: false, reason: 'PUBLIC_KEY_MISSING', payload: null };
  }
  const token = readLicenseToken();
  if (!token) {
    return { valid: false, reason: 'NO_LICENSE', payload: null };
  }
  try {
    const payload = jwt.verify(token, publicKey, { algorithms: ['RS256'] });
    return { valid: true, reason: null, payload };
  } catch (e) {
    if (e.name === 'TokenExpiredError') {
      return { valid: false, reason: 'EXPIRED', payload: jwt.decode(token) };
    }
    return { valid: false, reason: 'INVALID', payload: null };
  }
}

let cache = { result: null, ts: 0 };

/** Hasil di-cache CACHE_TTL_MS biar gak baca file/verify JWT tiap request. */
function verifyLicense({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && cache.result && now - cache.ts < CACHE_TTL_MS) return cache.result;
  const result = verifyLicenseRaw();
  cache = { result, ts: now };
  return result;
}

function totalSeats(payload) {
  if (!payload) return 0;
  return (payload.base_seats || 0) + (payload.addon_seats || 0);
}

const REASON_MESSAGE = {
  NO_LICENSE: 'Lisensi belum terpasang. Hubungi vendor untuk mendapatkan license key.',
  EXPIRED: 'Lisensi sudah berakhir. Hubungi vendor untuk perpanjangan.',
  INVALID: 'Lisensi tidak valid atau rusak. Hubungi vendor.',
  PUBLIC_KEY_MISSING: 'Konfigurasi lisensi aplikasi bermasalah. Hubungi vendor.',
};

module.exports = { verifyLicense, countUsedSeats, totalSeats, REASON_MESSAGE };
