/* ⚠️ INTERNAL VENDOR ONLY. Layanan kecil buat "phone-home" -- server
 * customer check-in ke sini secara berkala (lihat helpers/phone-home.js
 * di project utama). TUJUANNYA: dapetin waktu SEKARANG dari mesin yang
 * BUKAN dikontrol customer -- kalau app di server customer nemuin jam
 * lokalnya beda jauh sama waktu yang dibalikin sini, itu sinyal kuat
 * jam sistemnya lagi diakalin.
 *
 * WAJIB dihosting di server/domain milik VENDOR SENDIRI, TERPISAH
 * total dari server customer manapun. Kalau udah siap dipakai beneran,
 * pindahin folder ini ke REPO GIT SENDIRI (bukan bagian dari project
 * pt-gokak-indonesia) -- dipisah dari awal di sini biar gampang
 * dipindah, dan .dockerignore project utama udah mastiin folder ini
 * gak pernah ke-bundle ke image yang dikirim ke customer.
 *
 * Storage sengaja SIMPLE (file JSON, bukan MySQL) -- servis ini cuma
 * nyatet "siapa & kapan check-in", bukan sistem transaksional berat.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const PORT = process.env.PORT || 4000;
const PUBLIC_KEY = fs.readFileSync(path.join(__dirname, 'keys', 'license-public.pem'), 'utf8');
const DATA_FILE = path.join(__dirname, 'checkins.json');
const ADMIN_KEY = process.env.ADMIN_KEY || null; // buat lindungin GET /checkins, isi di .env kalau mau dipakai serius

function loadCheckins() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { return {}; }
}
function saveCheckins(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

const app = express();
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

/* ═══════════════════════════════════════════════════
   POST /checkin
   body: { license_key }
   Verifikasi tanda tangan token (gak perduli udah expired atau belum
   -- servis ini TETAP nyatet check-in-nya & tetap balikin server_time,
   soalnya validasi expired/gak itu udah jadi urusan app di sisi
   customer sendiri lewat helpers/license.js; di sini fokusnya cuma
   MEMASTIKAN token itu ASLI (bukan sekadar sembarang string) dan
   NYEDIAIN jam yang gak bisa diakalin dari sisi customer.
═══════════════════════════════════════════════════ */
app.post('/checkin', (req, res) => {
  const { license_key } = req.body;
  if (!license_key) {
    return res.status(400).json({ ok: false, message: 'license_key wajib diisi' });
  }

  let payload = null;
  let signatureValid = true;
  try {
    payload = jwt.verify(license_key, PUBLIC_KEY, { algorithms: ['RS256'], ignoreExpiration: true });
  } catch (e) {
    signatureValid = false;
  }

  const now = Date.now();
  if (signatureValid && payload) {
    const data = loadCheckins();
    const key = payload.customer || 'unknown';
    data[key] = {
      customer: payload.customer,
      base_seats: payload.base_seats,
      addon_seats: payload.addon_seats,
      exp: payload.exp,
      last_checkin_ms: now,
      last_checkin_ip: req.ip,
      total_checkins: (data[key]?.total_checkins || 0) + 1,
    };
    saveCheckins(data);
  }

  return res.json({
    ok: true,
    server_time: now,
    signature_valid: signatureValid,
    expired: payload ? payload.exp * 1000 < now : null,
  });
});

/* GET /checkins -- daftar customer & kapan terakhir check-in, buat kita
   pantau siapa yang lisensinya mau abis / siapa yang tiba-tiba berhenti
   check-in (jaringan bermasalah ATAU sengaja diputus). Dilindungi
   header x-admin-key sederhana -- bukan auth canggih, cukup buat
   internal, servis ini emang gak boleh public-facing tanpa proteksi
   tambahan (firewall/VPN) kalau beneran dipakai produksi. */
app.get('/checkins', (req, res) => {
  if (ADMIN_KEY && req.headers['x-admin-key'] !== ADMIN_KEY) {
    return res.status(403).json({ ok: false, message: 'Unauthorized' });
  }
  return res.json({ ok: true, checkins: loadCheckins() });
});

app.listen(PORT, () => {
  console.log(`🛰️  Vendor License Service jalan di http://localhost:${PORT}`);
  console.log(`   POST /checkin`);
  console.log(`   GET  /checkins ${ADMIN_KEY ? '(dilindungi x-admin-key)' : '(⚠️ TANPA PROTEKSI, set ADMIN_KEY di .env)'}`);
});
