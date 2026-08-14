/* Phone-home OPSIONAL ke License Service vendor (vendor-license-
 * service/, HARUS dihosting terpisah -- lihat notesubscribe.md Fase
 * 2-C). Cuma aktif kalau env LICENSE_SERVICE_URL diisi -- kalau
 * kosong (situasi SAAT INI, servisnya belum di-hosting beneran),
 * modul ini gak ngapa-ngapain sama sekali: gak ada request keluar,
 * gak ada perilaku yang berubah, aman buat semua instalasi existing.
 *
 * Tujuannya nutupin celah yang diakui di helpers/license.js: deteksi
 * jam mundur yang LOKAL (checkClockIntegrity) bisa dikelabui kalau
 * orangnya tau caranya HAPUS baris `pt_kapuk_license_state` BARENGAN
 * mundurin jam. Kalau phone-home ini aktif & sukses connect ke server
 * vendor, waktu dari SANA (mesin yang customer gak kontrol) dipakai
 * buat nge-set ulang jangkarnya -- gak bisa di-reset sepihak dari sisi
 * customer selama internetnya nyambung ke vendor.
 */
const pool = require('../db');
const { readLicenseToken, bumpClockAnchor } = require('./license');

const LICENSE_SERVICE_URL = process.env.LICENSE_SERVICE_URL;
const CHECKIN_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 jam

async function checkinOnce() {
  if (!LICENSE_SERVICE_URL) return; // fitur mati total kalau gak dikonfigurasi

  const token = readLicenseToken();
  if (!token) return;

  try {
    const res = await fetch(`${LICENSE_SERVICE_URL.replace(/\/$/, '')}/checkin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify({ license_key: token }),
    });
    if (!res.ok) return;
    const data = await res.json();
    if (data.server_time) {
      await bumpClockAnchor(pool, data.server_time);
      console.log('[PHONE-HOME] check-in sukses, jam server vendor:', new Date(data.server_time).toISOString());
    }
  } catch (e) {
    // Gagal connect (internet mati, servis vendor down, dll) -- SENGAJA
    // gak bikin lisensi lokal ikut invalid gara-gara ini. Ini cuma
    // lapisan TAMBAHAN, bukan satu-satunya jaring pengaman -- lihat
    // notesubscribe.md soal kebijakan grace period.
    console.error('[PHONE-HOME] gagal check-in (diabaikan, coba lagi nanti):', e.message);
  }
}

function start() {
  if (!LICENSE_SERVICE_URL) {
    console.log('[PHONE-HOME] LICENSE_SERVICE_URL gak diisi -- fitur ini nonaktif (normal buat instalasi yang belum pakai License Service).');
    return;
  }
  console.log('[PHONE-HOME] aktif, check-in ke', LICENSE_SERVICE_URL, 'tiap', CHECKIN_INTERVAL_MS / 3600000, 'jam');
  checkinOnce(); // langsung sekali pas startup, gak nunggu interval pertama
  setInterval(checkinOnce, CHECKIN_INTERVAL_MS);
}

module.exports = { start, checkinOnce };
