const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const http = require('http');
require('dotenv').config();

const { initSocket } = require('./socket');
const authRoute      = require('./routes/auth.route');
const userRoute      = require('./routes/user.route');
const taskRoute      = require('./routes/task.route');
const masterRoute    = require('./routes/master.route');
const pmRoute        = require('./routes/pm.route');
const dashboardRoute = require('./routes/dashboard.route');
const kpiRoute       = require('./routes/kpi.route');
const settingsRoute  = require('./routes/settings.route');

const app = express();
const PORT = process.env.PORT || 3010;

// Percaya header X-Forwarded-For dari reverse proxy (nginx/Caddy) di
// depan app -- TANPA ini, req.ip SELALU keliatan alamat proxy-nya
// sendiri (misal 127.0.0.1) buat SEMUA request, bikin rate-limit
// per-IP di bawah (login, /api/license/request) gak berguna sama
// sekali (semua orang keitung "1 IP" yang sama). Aman diaktifin
// default -- kalau app-nya DIAKSES LANGSUNG tanpa reverse proxy pun
// gak ada downside nyata di setup ini.
app.set('trust proxy', 1);

// Header keamanan standar (X-Content-Type-Options, X-Frame-Options,
// hilangin X-Powered-By, dst). contentSecurityPolicy DIMATIKAN SENGAJA
// -- app ini masih pakai banyak inline <script> + load MapLibre GL &
// Socket.IO client dari CDN (unpkg/cdn.socket.io) di tiap halaman
// admin, CSP default helmet bakal nge-block SEMUA itu & bikin
// dashboard putih blank. Ngerapihin ke CSP proper (nonce per inline
// script, self-host semua library) itu kerjaan terpisah, bukan quick
// win -- lebih baik jujur DIMATIKAN daripada nyalain versi yang bikin
// aplikasinya rusak.
app.use(helmet({ contentSecurityPolicy: false }));

// CORS SENGAJA gak dibuka lebar (`cors()` polos = izinin origin APAPUN)
// -- app ini single-origin (frontend & API sama-sama diserve dari
// server yang sama, gak ada frontend terpisah yang butuh cross-origin
// fetch beneran). Kosongin ALLOWED_ORIGINS di .env (default) = CORS
// gak diaktifkan sama sekali (browser tetap bisa akses normal karena
// same-origin, cuma situs LAIN gak bisa fetch API ini pakai token yang
// mungkin ke-leak). Isi ALLOWED_ORIGINS kalau suatu saat beneran butuh
// frontend terpisah (misal subdomain beda).
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
if (allowedOrigins.length > 0) {
  app.use(cors({ origin: allowedOrigins }));
}

app.use(express.json());

// Endpoint yang HARUS tetap kejawab APAPUN status lisensinya -- health
// check buat infra monitoring, config publik buat halaman peta, dan
// status lisensi itu sendiri (biar admin tau KENAPA dia kelock, bukan
// cuma dapet error kosong). Makanya ketiganya didaftarin SEBELUM
// gerbang lisensi di bawah.
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// Koordinat pabrik dipakai frontend buat auto-center KAMERA peta --
// bukan sumber geofence (itu dari poligon pt_kapuk_area). Taruh di
// satu endpoint publik kecil biar gak perlu hardcode ganda di JS.
// SAAT INI dialihkan ke lokasi kantor (Ruko Pesona View Blok C7) buat
// masa development -- lihat .env.example.
app.get('/api/config', (req, res) => {
  res.json({
    factoryCenter: {
      lat: Number(process.env.FACTORY_LAT) || -6.380064,
      lng: Number(process.env.FACTORY_LNG) || 106.8408239,
    }
  });
});

// Login route
// tetap bisa login walaupun lisensinya lagi invalid/expired, soalnya
// justru itu jalan satu-satunya buat dia masuk dashboard & TEMPEL
// TOKEN LISENSI BARU lewat menu Lisensi / halaman lock (lihat
// POST /api/license/activate di routes/license.route.js). Kalau login
// ikut keblokir, admin gak akan pernah bisa masukin lisensi baru sama
// sekali tanpa akses SSH/file server -- itu bukan yang diminta.
app.use('/api/auth', authRoute);

app.use('/api/users', userRoute);
app.use('/api/tasks', taskRoute);
app.use('/api/master', masterRoute);
app.use('/api/pm', pmRoute);
app.use('/api/dashboard', dashboardRoute);
app.use('/api/kpi', kpiRoute);
app.use('/api/settings', settingsRoute);

// Foto bukti pengerjaan tiket yang diupload admin/teknisi
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

/* ═══════════════════════════════════════════════════
   CLEAN URL — sembunyiin ekstensi .html.
   1) /sesuatu.html -> redirect permanen ke /sesuatu
   2) /sesuatu (tanpa ekstensi) di-serve dari public/sesuatu.html kalau
      ada -- termasuk yang di dalam subfolder /admin dan /teknisi.
      Dipasang SEBELUM express.static(public) tapi SETELAH semua route
      /api & /health di atas supaya gak ketabrak.
═══════════════════════════════════════════════════ */
const PUBLIC_DIR = path.join(__dirname, 'public');

app.get(/^\/(.+)\.html$/, (req, res) => {
  res.redirect(301, `/${req.params[0]}`);
});

app.get(/^\/([\w-]+(?:\/[\w-]+)*)$/, (req, res, next) => {
  const filePath = path.join(PUBLIC_DIR, `${req.params[0]}.html`);
  fs.access(filePath, fs.constants.F_OK, (err) => {
    if (err) return next(); // bukan halaman .html yang dikenal -> lanjut ke static/404 biasa
    res.sendFile(filePath);
  });
});

// Dashboard web (frontend statis) — satu server buat API + tampilan.
app.use(express.static(PUBLIC_DIR));

const httpServer = http.createServer(app);
initSocket(httpServer);

httpServer.listen(PORT, () => {
  console.log(`🚀 Monitoring App — Tracking & Tiket System jalan di http://localhost:${PORT}`);
  console.log(`   🖥️  Portal Admin   : http://localhost:${PORT}/admin/login`);
  console.log(`   🧑‍🔧 Portal Teknisi : http://localhost:${PORT}/teknisi/login`);
  console.log(``);
  console.log(`   POST   /api/auth/admin/login`);
  console.log(`   POST   /api/auth/teknisi/login`);
  console.log(`   GET    /api/teknisi`);
  console.log(`   POST   /api/teknisi/:id/status         (teknisi: ONLINE/OFFLINE/ON_TASK)`);
  console.log(`   POST   /api/teknisi/:id/location       (GPS ping selama online)`);
  console.log(`   GET    /api/teknisi/:id/lokasi-history`);
  console.log(`   GET    /api/tiket                      (admin: semua; teknisi: ?mine=1)`);
  console.log(`   POST   /api/tiket                      (admin: create + assign langsung)`);
  console.log(`   POST   /api/tiket/:id/assign            (admin: assign teknisi)`);
  console.log(`   DELETE /api/tiket/:id/assign/:teknisiId`);
  console.log(`   POST   /api/tiket/:id/status            (teknisi: progres; admin: cancel)`);
  console.log(`   POST   /api/tiket/:id/files             (upload foto bukti)`);
  console.log(`   GET    /api/dashboard/kpi`);
  console.log(`   GET    /api/dashboard/monitoring`);
  console.log(`   GET    /api/dashboard/analytics`);
  console.log(`   GET    /api/area                        (poligon area pabrik)`);
  console.log(`   POST   /api/area / PUT /:id / DELETE /:id`);
  console.log(`   GET    /api/kpi/ringkasan               (tabel kehadiran semua karyawan)`);
  console.log(`   GET    /api/kpi/heatmap/:teknisiId       (kalender ala GitHub)`);
  console.log(`   GET    /api/kpi/harian/:teknisiId        (detail 1 hari + sesi keluar-area)`);
  console.log(`🔌 Socket.IO aktif (register-dashboard / register-teknisi)`);
  console.log(`   GET    /health`);
});
