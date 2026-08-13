const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const http = require('http');
require('dotenv').config();

const { initSocket } = require('./socket');

const authRoute      = require('./routes/auth.route');
const teknisiRoute   = require('./routes/teknisi.route');
const tiketRoute     = require('./routes/tiket.route');
const dashboardRoute = require('./routes/dashboard.route');
const areaRoute      = require('./routes/area.route');
const kpiRoute       = require('./routes/kpi.route');

const app = express();
const PORT = process.env.PORT || 3010;

app.use(cors());
app.use(express.json());

app.use('/api/auth', authRoute);
app.use('/api/teknisi', teknisiRoute);
app.use('/api/tiket', tiketRoute);
app.use('/api/dashboard', dashboardRoute);
app.use('/api/area', areaRoute);
app.use('/api/kpi', kpiRoute);

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
    },
  });
});

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// Foto bukti pengerjaan tiket yang diupload admin/teknisi
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

/* ═══════════════════════════════════════════════════
   CLEAN URL — sembunyiin ekstensi .html, sama kayak pola be-oki-app.
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
  console.log(`🚀 PT Gokak Indonesia — Tracking & Tiket System jalan di http://localhost:${PORT}`);
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
