/* Verifikasi license key (JWT ditandatangani RS256 -- lihat
 * licensing-tools/generate-license.js buat cara bikinnya) DITAMBAH
 * deteksi manipulasi jam sistem (checkClockIntegrity).
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

let APP_VERSION = '0.0.0';
try {
  APP_VERSION = fs.readFileSync(path.join(__dirname, '..', 'VERSION'), 'utf8').trim();
} catch (e) { /* belum ada file VERSION, biarin default */ }

// Seat DIHITUNG DARI TEKNISI AKTIF SAJA, bukan admin -- lihat asumsi
// bisnis di notesubscribe.md bagian 3. Kalau nanti admin juga mau
// dihitung, tinggal ubah query di countUsedSeats().
async function countUsedSeats(pool) {
  const [[row]] = await pool.query(`SELECT COUNT(*) AS n FROM pt_gokak_users WHERE is_active = 1 AND role = 'MEKANIK'`);
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

/* ═══════════════════════════════════════════════════
   BINDING id_mitra (OPSIONAL, opt-in lewat env ID_MITRA).

   Tiap paket Docker yang dikirim ke customer dibikinin `.env` SENDIRI
   sama vendor, isinya `ID_MITRA=<kode unik customer itu>` yang UDAH
   DITENTUKAN vendor pas nyiapin instalasinya (bukan customer yang
   isi/pilih sendiri). Token lisensinya (dibikin licensing-tools/
   generate-license.js) juga nyimpen `id_mitra` yang SAMA di payload-nya.

   Begitu ID_MITRA keisi di .env, app WAJIB nyocokin `payload.id_mitra`
   token yang lagi dipasang sama nilai env itu -- kalau beda (atau
   tokennya gak punya id_mitra sama sekali padahal .env-nya udah
   di-set), token DITOLAK meskipun tanda tangannya sah. Efeknya: 1
   token cuma bisa dipasang di instalasi yang emang DITUJUKAN vendor
   buat customer itu -- gak bisa asal comot license.lic customer lain
   terus ditempel di instalasi yang beda.

   Kalau ID_MITRA gak diisi di .env sama sekali (default buat dev/
   testing/instalasi lama sebelum fitur ini ada), pengecekan ini SKIP
   total -- gak ada perilaku yang berubah, konsisten sama pola opt-in
   lain di file ini (LICENSE_SERVICE_URL, dst).
═══════════════════════════════════════════════════ */
function checkIdMitra(payload) {
  const expected = process.env.ID_MITRA;
  if (!expected) return { ok: true }; // fitur gak diaktifkan di instalasi ini
  const actual = payload?.id_mitra;
  if (!actual || actual.trim().toLowerCase() !== expected.trim().toLowerCase()) {
    return { ok: false };
  }
  return { ok: true };
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
    if (!checkIdMitra(payload).ok) {
      return { valid: false, reason: 'ID_MITRA_MISMATCH', payload };
    }
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

/* ═══════════════════════════════════════════════════
   DETEKSI JAM SISTEM DIMUNDURIN.

   Ide dasarnya: `pt_kapuk_license_state` (1 baris, id=1) nyimpen waktu
   PALING BESAR yang PERNAH keliatan sama app ini (monoton naik terus).
   Kalau `Date.now()` SEKARANG ternyata lebih kecil dari itu (dikurangi
   sedikit toleransi buat jitter wajar), berarti jam sistemnya baru aja
   dimundurin -- entah manual, entah scripting -- dan lisensi otomatis
   dianggap TIDAK VALID apapun kata `exp` di JWT-nya, karena JWT itu
   sendiri yang mau "ditipu" pakai cara ini.

   BATASAN JUJUR (dicatat juga di notesubscribe.md bagian 9): ini
   pertahanan LOKAL, bukan verifikasi ke server independen. Yang tahu
   soal tabel ini DAN punya akses database bisa aja langsung UPDATE
   baris ini manual buat "reset jangkarnya". Yang ini tutup itu cuma
   serangan PALING GAMPANG/PALING UMUM (sekadar ganti jam sistem lewat
   Control Panel/`date` command) -- bukan serangan tercanggih. Penutup
   yang lebih kuat (gak bisa di-reset sepihak sama customer) itu
   verifikasi ONLINE ke server vendor (Fase 2 bagian C di
   notesubscribe.md), yang butuh infra terpisah, belum tersedia.
═══════════════════════════════════════════════════ */
const CLOCK_TOLERANCE_MS = 2 * 60 * 1000; // toleransi jitter wajar (NTP, restart, dst), BUKAN buat "maafin" rollback beneran
let clockCache = { result: null, ts: 0 };

async function checkClockIntegrityRaw(pool) {
  const nowMs = Date.now();
  const [[row]] = await pool.query(`SELECT last_verified_ms FROM pt_kapuk_license_state WHERE id = 1`);

  if (!row) {
    // Instalasi baru / baris belum pernah dibikin -- gak ada riwayat
    // buat dibandingin, langsung anggap OK & mulai jangkarnya dari sini.
    await pool.query(`INSERT INTO pt_kapuk_license_state (id, last_verified_ms) VALUES (1, ?)`, [nowMs]);
    return { tampered: false };
  }

  if (nowMs < row.last_verified_ms - CLOCK_TOLERANCE_MS) {
    return { tampered: true, lastKnownMs: row.last_verified_ms, nowMs };
  }

  const newAnchor = Math.max(nowMs, row.last_verified_ms);
  if (newAnchor !== row.last_verified_ms) {
    await pool.query(`UPDATE pt_kapuk_license_state SET last_verified_ms = ? WHERE id = 1`, [newAnchor]);
  }
  return { tampered: false };
}

/** Di-cache CACHE_TTL_MS juga -- gak perlu query+update DB tiap request. */
async function checkClockIntegrity(pool, { forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && clockCache.result && now - clockCache.ts < CACHE_TTL_MS) return clockCache.result;
  const result = await checkClockIntegrityRaw(pool);
  clockCache = { result, ts: now };
  return result;
}

/**
 * Verifikasi LENGKAP (JWT + integritas jam) -- ini yang dipakai
 * middleware/license.js, bukan verifyLicense() polos. Cek JWT dulu
 * (gak perlu DB kalau udah invalid dari situ), baru cek jam kalau
 * JWT-nya sendiri masih keliatan valid.
 */
async function verifyLicenseFull(pool) {
  const jwtResult = verifyLicense();
  if (!jwtResult.valid) return jwtResult;

  try {
    const clock = await checkClockIntegrity(pool);
    if (clock.tampered) {
      return { valid: false, reason: 'CLOCK_TAMPERED', payload: jwtResult.payload };
    }
  } catch (e) {
    // Gagal cek DB (misal lagi startup, DB belum connect) -- JANGAN
    // ikut nge-lock gara-gara ini, itu beda masalah sama lisensi.
    console.error('[LICENSE] gagal cek integritas jam:', e.message);
  }

  return jwtResult;
}

function totalSeats(payload) {
  if (!payload) return 0;
  return (payload.base_seats || 0) + (payload.addon_seats || 0);
}

/**
 * Dorong jangkar jam (pt_kapuk_license_state) ke `ms` KALAU itu lebih
 * besar dari nilai yang tersimpan sekarang -- dipakai `helpers/phone-
 * home.js` buat "nyuntikin" waktu dari server vendor (yang gak
 * dikontrol customer) ke jangkar lokal. INI YANG NUTUPIN celah "hapus
 * baris jangkar + mundurin jam sekaligus" (lihat catatan di
 * checkClockIntegrityRaw) -- SELAMA phone-home ini beneran kekonfigurasi
 * & bisa connect ke internet.
 */
async function bumpClockAnchor(pool, ms) {
  await pool.query(
    `INSERT INTO pt_kapuk_license_state (id, last_verified_ms) VALUES (1, ?)
     ON DUPLICATE KEY UPDATE last_verified_ms = GREATEST(last_verified_ms, VALUES(last_verified_ms))`,
    [ms],
  );
  clockCache = { result: null, ts: 0 }; // paksa re-check di request berikutnya, jangan pakai cache basi
}

/**
 * Cek tanda tangan token TANPA peduli udah expired atau belum --
 * dipakai activateLicense() di bawah buat ngasih pesan yang jelas ke
 * admin ("token ini gak valid sama sekali" vs isu lain), sebelum
 * ditulis ke file. ignoreExpiration: true SENGAJA, soalnya nge-tempel
 * token yang udah expired itu VALID secara alur (misal admin salah
 * tempel token lama) -- biar verifyLicense() normal yang nanti
 * nentuin EXPIRED-nya, bukan ditolak di sini duluan.
 */
function verifyTokenSignatureOnly(token) {
  if (!publicKey) return { valid: false, reason: 'PUBLIC_KEY_MISSING' };
  try {
    const payload = jwt.verify(token, publicKey, { algorithms: ['RS256'], ignoreExpiration: true });
    return { valid: true, payload };
  } catch (e) {
    return { valid: false, reason: 'INVALID' };
  }
}

/**
 * Aktivasi lisensi baru LEWAT DASHBOARD (bukan lewat akses file server)
 * -- dipanggil dari routes/license.route.js, endpoint POST
 * /api/license/activate (admin only, lihat middleware requireAuth +
 * requireAdmin di sana). Admin cukup tempel token yang dikirim vendor
 * ke form di menu Lisensi / halaman lock, gak perlu akses SSH/file
 * server sama sekali.
 *
 * Validasi tanda tangan DAN id_mitra (kalau fitur binding-nya aktif,
 * lihat checkIdMitra) DULU sebelum nulis ke file -- kalau tokennya
 * ngaco/ke-corrupt/salah instalasi pas di-paste, `license.lic` yang
 * LAMA (yang mungkin masih valid) gak ikut ketimpa jadi rusak/salah.
 */
function activateLicense(token) {
  const check = verifyTokenSignatureOnly(token);
  if (!check.valid) return { success: false, reason: check.reason };
  if (!checkIdMitra(check.payload).ok) return { success: false, reason: 'ID_MITRA_MISMATCH' };

  fs.writeFileSync(LICENSE_FILE_PATH, `${token}\n`, 'utf8');
  cache = { result: null, ts: 0 }; // paksa re-verify, jangan pakai cache lisensi lama
  return { success: true };
}

const REASON_MESSAGE = {
  NO_LICENSE: 'Lisensi belum terpasang. Hubungi vendor untuk mendapatkan license key.',
  EXPIRED: 'Lisensi sudah berakhir. Hubungi vendor untuk perpanjangan.',
  INVALID: 'Lisensi tidak valid atau rusak. Hubungi vendor.',
  PUBLIC_KEY_MISSING: 'Konfigurasi lisensi aplikasi bermasalah. Hubungi vendor.',
  CLOCK_TAMPERED: 'Jam sistem server terdeteksi dimundurkan. Perbaiki jam sistem lalu coba lagi, atau hubungi vendor kalau ini keliru.',
  ID_MITRA_MISMATCH: 'ID mitra pada token lisensi ini tidak cocok dengan konfigurasi server (ID_MITRA di .env). Pastikan token ini memang untuk instalasi yang sama, atau hubungi vendor kalau menurut Anda ini keliru.',
};

module.exports = {
  verifyLicense, verifyLicenseFull, checkClockIntegrity, bumpClockAnchor,
  readLicenseToken, activateLicense, countUsedSeats, totalSeats, REASON_MESSAGE, APP_VERSION,
};
