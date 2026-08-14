# PT Gokak Indonesia — Employee Tracking & Ticket System

Aplikasi internal untuk **monitoring lokasi karyawan/teknisi di area pabrik** lewat peta 3D real-time, **assign tugas (tiket)** langsung dari dashboard admin, dan **KPI kehadiran** (berapa lama online, di dalam vs di luar area pabrik). Fokusnya cuma 5 hal: **Dashboard (peta monitoring)**, **Teknisi (karyawan)**, **Tiket**, **Kehadiran (KPI)**, dan **Area Pabrik (poligon 3D)** — sengaja gak ada modul customer, finance, atau approval berjenjang, karena ini sistem internal pabrik sendiri.

> ⚠️ **Lokasi development SAAT INI dialihkan ke kantor** (Ruko Pesona View, Blok C7, `-6.380064, 106.8408239`) — BUKAN lokasi pabrik asli PT Gokak Indonesia. Ini diset lewat `FACTORY_LAT`/`FACTORY_LNG` di `.env` (cuma nentuin arah kamera default) + 1 area seed di `schema.sql` (geofence beneran). Ganti kapan pun development pindah ke lokasi pabrik — tinggal edit `.env` buat kameranya, dan gambar ulang area yang presisi lewat halaman **Area Pabrik** (lihat bagian 6).

---

## 1. Fokus & prinsip desain

Sistem ini murni buat **internal pabrik sendiri** — gak ada konsep customer eksternal, gak ada uang jalan/approval berjenjang. Prinsip yang dipegang:

- **Gak ada approval berjenjang.** Cuma ada role `ADMIN` (dan `SUPERVISOR` yang disiapkan, belum dipakai) — admin bisa create & assign tiket langsung, teknisi juga bisa bikin tiket sendiri (bagian 10), gak perlu nunggu siapa-siapa nyetujuin.
- **Login JWT terpisah** staff vs lapangan (`middleware/auth.js`) → **Admin vs Teknisi**, dengan portal frontend yang benar-benar kepisah folder (`/admin/*` vs `/teknisi/*`).
- **GPS ping teknisi tiap ~30 detik** + riwayat lokasi (`pt_kapuk_teknisi_lokasi`) jadi dasar dua hal: titik di peta live DAN hitungan **KPI kehadiran** (bagian 5). Sempet dicoba 2 detik biar peta lebih "real-time", tapi dibalikin ke 30 detik — GPS+network sesering itu boros baterai HP teknisi buat manfaat yang gak sebanding.
- **Socket.IO realtime** buat live map & notifikasi assign — gak ada push notification ke HP (FCM) dulu, cukup realtime selama tab/app-nya terbuka.

---

## 2. Penamaan

- Tugas disebut **"Tiket"** di semua tempat: tabel, route, endpoint, UI, variabel.
- Semua tabel pakai prefix **`pt_kapuk_`**.
- **Technician → Teknisi** tetap istilah utama di kode/UI (bukan "karyawan").

---

## 3. Skema database (9 tabel)

```
pt_kapuk_admins            -- akun admin (login dashboard)
pt_kapuk_area              -- poligon 3D area pabrik (geofence buat KPI kehadiran)
pt_kapuk_teknisi           -- akun & profil karyawan/teknisi + status & lokasi terakhir
pt_kapuk_teknisi_lokasi    -- riwayat GPS teknisi tiap ping (in_area/area_id disnapshot di sini)
pt_kapuk_teknisi_area      -- area kerja yang di-assign admin ke teknisi (many-to-many)
pt_kapuk_tiket             -- tiket tugas (dulu "order")
pt_kapuk_tiket_teknisi     -- teknisi yang di-assign ke tiket (bisa >1 orang/tiket)
pt_kapuk_tiket_timeline    -- log aktivitas per tiket
pt_kapuk_tiket_files       -- foto bukti pengerjaan (opsional, upload bebas)
```

Poin penting:
- `pt_kapuk_teknisi.status`: `OFFLINE` / `ONLINE` / `ON_TASK`.
- `pt_kapuk_tiket.status`: `NEW` → `ASSIGNED` → `IN_PROGRESS` → `DONE` (atau `CANCELLED`). Tanpa approval, tanpa BA-checklist — begitu admin assign (atau teknisi bikin sendiri), langsung `ASSIGNED`.
- `pt_kapuk_tiket.created_by_admin_id` / `created_by_teknisi_id`: tiket bisa dibuat **ADMIN atau TEKNISI sendiri** (self-service) — persis kayak kolom `uploaded_by_admin_id`/`uploaded_by_teknisi_id` di `tiket_files`, cuma salah satu yang keisi.
- `pt_kapuk_tiket.area_id`: lokasi kerja tiket, WAJIB pilih dari master `pt_kapuk_area` (dropdown, bukan teks bebas) — tetap bisa diedit (admin atau teknisi yang di-assign) sampai tiket `DONE`/`CANCELLED`.
- `pt_kapuk_tiket.tanggal_mulai`/`tanggal_selesai`: rencana jadwal kerja (`DATE`) — beda sama `selesai_at` (`DATETIME`, waktu ACTUAL pas tiket di-klik selesai).
- `pt_kapuk_area.is_primary`: area yang DIHITUNG sebagai "dalam area pabrik" buat KPI kehadiran (union semua area primary). Area non-primary cuma referensi visual (misal area parkir).
- `pt_kapuk_teknisi_lokasi.in_area`/`area_id`: hasil cek point-in-polygon **disnapshot saat ping masuk**, bukan dihitung ulang belakangan — jadi histori KPI gak berubah kalau poligon area diedit admin di kemudian hari.
- `pt_kapuk_teknisi_area`: 1 teknisi boleh di-assign ke **beberapa area** dari master `pt_kapuk_area` (dikelola dari halaman Teknisi). **Sifatnya organisasi/informasi** ("teknisi ini seharusnya kerja di area mana") — BUKAN yang nentuin `in_area` di atas, itu tetap union semua area `is_primary` apapun teknisinya. Ini JUGA yang jadi sumber pilihan dropdown "Area/Lokasi Kerja" pas bikin tiket (lihat bagian 10).
- Detail kolom lengkap: lihat [`schema.sql`](./schema.sql).

---

## 4. Roles & Auth

| | Admin | Teknisi |
|---|---|---|
| Login | `POST /api/auth/admin/login` | `POST /api/auth/teknisi/login` |
| Portal | `/admin/login` → `/admin/dashboard` | `/teknisi/login` → `/teknisi/home` |
| Bisa apa | Peta semua teknisi, kelola akun, create/assign/batalkan tiket, KPI kehadiran, kelola area pabrik | Toggle status online/offline, lihat tiket yang di-assign, update progres, kirim GPS ping otomatis selama online |

---

## 5. KPI Kehadiran (halaman `/admin/kehadiran`)

Tujuan: admin bisa lihat **berapa lama tiap karyawan online di area pabrik** (harian/mingguan/bulanan) buat bahan laporan/KPI, plus detail kapan dia online tapi **di luar area** (buat investigasi).

- **Kalender heatmap ala GitHub** (`public/js/calendar-heatmap.js`) — kotak per hari, makin gelap makin lama online (skala tetap: patokan hari kerja ±8 jam, bukan relatif ke data, biar warnanya konsisten artinya lintas karyawan). Klik 1 kotak → buka detail hari itu.
- **Detail harian** nunjukin TIGA rentang waktu terpisah (bukan cuma total angka): kapan **online** (apapun posisinya), kapan online **di dalam area**, kapan online tapi **di luar area** — masing-masing sebagai daftar jam mulai–selesai (mis. `12:05 – 12:40, 35 menit`), plus 3 kartu total di atasnya.
- **Tabel ringkasan semua karyawan** dengan quick filter Hari ini/Minggu ini/Bulan ini + search nama, dipaginasi (didesain buat skala 500–1000 karyawan).
- **Cara hitung** (`helpers/kehadiran.js`) — GAK ada tabel sesi terpisah, dihitung dari **gap antar ping GPS**: ping dikirim tiap 30 detik selama online; gap wajar (≤ 90 detik — 3× interval, toleransi jeda network/GPS sebentar) dianggap online penuh & diklasifikasi in-area/out-area dari kolom `in_area` ping tersebut; gap yang jauh lebih lama (device mati/tab ditutup) dianggap disconnect dan dipotong ke 90 detik.
  - **Daftar rentang waktu dirapikan** biar gak kepanjangan: (1) blip GPS di deket garis batas poligon (posisi goyang beberapa meter bisa keluar-masuk status `in_area` tiap ping) di-*bridge* — kalau durasi "keluar"-nya ≤ 45 detik (1.5× interval, cukup buat nutupin 1 ping nyasar) dan abis itu balik lagi, dianggap noise, sesi tetep dianggap nyambung; (2) sesi yang tetep kependekan (< 1 menit) DIBUANG dari daftar yang ditampilin (dilaporin sebagai "+N sesi singkat disembunyikan"); (3) tiap daftar juga dibatasi tinggi + di-scroll (`.session-list` di `style.css`) sebagai jaring pengaman kalau suatu hari tetep ada banyak entri. Kartu total (Total Online/Di Area/Luar Area) **tetap presisi**, gak kepengaruh sama sekali — cuma daftarnya yang disaring/dirapikan.
  - Endpoint `/api/kpi/harian` & `/api/kpi/heatmap` hitung **presisi per-detik** dari ping mentah (aman karena cuma 1 karyawan per request).
  - Endpoint `/api/kpi/ringkasan` (tabel SEMUA karyawan sekaligus) pakai **pendekatan cepat** `COUNT(ping) × 30 detik` di level SQL supaya tetap ringan di skala 500–1000 karyawan — sedikit kurang presisi di ekor sesi, tapi valid karena ping memang terkirim tiap 30 detik selama online.
  - Simplifikasi yang disengaja: segmen yang pas nyebrang tengah malam dihitung penuh ke hari mulainya (bukan dipecah proporsional) — selisihnya gak signifikan.

---

## 6. Area Pabrik 3D (halaman `/admin/area`)

Admin gambar poligon LANGSUNG di atas peta 3D beneran (klik titik demi titik di lokasi asli), bukan input koordinat manual:

- **+ Gambar Area Baru** → klik peta buat nambah titik (min. 3), tombol Undo/Bersihkan, **Selesai Gambar** → isi nama, warna, tinggi (meter), dan centang **"area primary"** (dihitung ke KPI kehadiran) atau bukan (cuma referensi visual, misal area parkir).
- Bisa punya **banyak area, beberapa di antaranya primary** — union semua area primary itulah yang jadi geofence "dalam area pabrik".
- Tiap area disimpan sebagai poligon 3D (`fill-extrusion`) dengan warna & tinggi masing-masing, dirender di peta dashboard maupun halaman ini sendiri.
- Edit = muat ulang poligon lama ke mode gambar (bisa di-Undo/gambar ulang) + prefill metadata, lalu simpan lewat alur yang sama kayak bikin baru.
- Hapus area gak menghapus histori kehadiran yang udah tercatat (FK `ON DELETE SET NULL` di `pt_kapuk_teknisi_lokasi.area_id`).

---

## 7. Peta 3D

- **MapLibre GL JS + tile vector OpenFreeMap** (gratis, tanpa API key). Style `liberty` udah punya layer 3D building bawaan + MapLibre native support kamera 3D (pitch/tilt/rotate).
- **Dikunci cuma di area pabrik**: `maxBounds`/`minZoom` bikin peta gak bisa di-pan/zoom-out keluar radius lokasi — "3D khusus area situ aja".
- **Poligon area pabrik** (bagian 6) yang jadi blok 3D-nya, BUKAN lagi file statis — jadi begitu admin gambar/edit area, semua peta (dashboard, halaman area) langsung ikut berubah begitu di-reload.
- **Pin nama di tiap area** — label `📍 Nama Area` ngambang di titik tengah tiap poligon, biar keliatan area mana yang mana dari atas tanpa perlu klik satu-satu. Klik langsung ke blok gedung/area 3D-nya **sengaja gak munculin popup apa-apa** (namanya udah keliatan dari pin label ini) — popup data cuma muncul kalau klik **titik/icon teknisi**, biar gak ambigu klik yang mana yang beneran nampilin info.
- **Langit & pencahayaan** (`map.setLight` + layer `sky`) — blok 3D punya gradasi terang/gelap (bukan flat 1 warna), plus atmosfer biru lembut di background. Otomatis di-skip kalau browser/versi MapLibre-nya belum support (gak bikin peta error).
- **Clustering marker teknisi** native MapLibre — ngelompok jadi bubble angka kalau berdekatan, pecah lagi pas di-zoom in/klik. Warna beda per status (hijau online / kuning bertugas / abu offline), plus halo lembut di belakang tiap titik biar kerasa "menyala".
- **Anti-numpuk buat titik yang lokasinya (hampir) sama** (`dodgeOverlappingPoints` di `admin-map.js`) — clustering di atas nanganin "banyak orang tersebar, dikelompokin pas di-zoom out", tapi kalau beberapa teknisi BENERAN di titik yang sama (misal ngerjain 1 mesin bareng), titiknya bakal tetep numpuk persis walau di-zoom in sejauh apapun. Sebelum digambar, titik-titik dalam radius ~6 meter dipisah otomatis jadi pola lingkaran kecil (~4 meter dari pusat kelompoknya) supaya masing-masing tetap keliatan & bisa diklik sendiri-sendiri — urutan sebarnya stabil (diurut by ID) biar gak "lompat-lompat" tiap live-update padahal orangnya diem. Posisi asli (buat geofence/KPI) sama sekali gak berubah, ini murni kosmetik gambar doang. Popup-nya kasih catatan kalau titik itu hasil sebar ("N orang di titik yang sama").
- **Dashboard full-screen**: peta jadi kanvas utuh (bukan kotak kecil di grid) — KPI, list teknisi, tiket terbaru, & aktivitas ngambang di panel kanan yang bisa di-collapse (tombol "☰ Panel"), didesain buat skala 500–1000 karyawan supaya map besar tetap jadi prioritas visual.
- Tombol "Reset Tampilan" & "Panel" digabung jadi bagian dari kartu topbar (`.map-topbar-actions`), gak lagi ngambang sendiri di pojok kiri-atas — sebelumnya itu numpuk/nutupin kartu judul dashboard (posisinya ketiban), sekarang jadi satu baris rapi bareng judul & user badge.
- Catatan: basemap dari OpenFreeMap tetap warna terang/netral di kedua tema (wajar — peta beneran, gak ikut skema warna app) — yang ganti gelap/terang itu semua chrome di sekitarnya (sidebar, panel, popup, kartu).

---

## 8. Dark mode / Terang mode

Toggle di kanan-atas tiap halaman (ikon 🌙/☀️), tersimpan di `localStorage` (`public/js/theme.js`). Default kalau belum pernah di-klik: ikut preferensi OS (`prefers-color-scheme`). Semua warna UI dipakai lewat CSS variable (`--bg`, `--panel`, `--text`, `--badge-*-bg/fg`, dst di `style.css`) yang di-override lewat `:root[data-theme="light"]` — jadi nambah/nyesuain warna tema tinggal edit satu tempat itu, gak perlu ubah tiap halaman.

---

## 9. Assign area kerja ke teknisi (halaman `/admin/teknisi`)

Di form tambah/edit teknisi, ada checklist **"Area Kerja"** — daftar semua area dari master (`/admin/area`), admin centang satu atau lebih. Disimpan lewat `POST /api/teknisi/:id/area` (replace-all, kirim ulang seluruh `area_ids` yang harusnya aktif buat teknisi itu). Kolom "Area Kerja" di tabel daftar teknisi nunjukin ringkasannya.

---

## 10. Bikin tiket — admin ATAU teknisi sendiri

Tiket sekarang bisa dibuat dari 2 sisi:

| | Admin (`/admin/tiket-detail`) | Teknisi (`/teknisi/tiket-baru`) |
|---|---|---|
| Teknisi yang dikerjakan | Opsional pilih 1+ dari checklist (boleh kosong dulu, `NEW`, di-assign belakangan) | Otomatis dirinya sendiri — begitu submit langsung `ASSIGNED` |
| Dropdown area/lokasi | Union area kerja dari SEMUA teknisi yang lagi dicentang (kosong = tampil semua area aktif) — jadi konsisten sama assignment yang di-set admin sendiri di menu Teknisi | HANYA area yang udah di-set admin buat dirinya (`pt_kapuk_teknisi_area`) — kalau belum ada, muncul pesan buat hubungi admin dulu |
| Validasi server | Bebas pilih area apapun (admin trusted, dia yang nentuin assignment-nya) | **Ditolak (403)** kalau area_id di luar area yang di-set admin buat dia |

Form-nya sama-sama punya **Tanggal Mulai**, **Tanggal Selesai**, dan dropdown **Area/Lokasi Kerja** (bukan teks bebas lagi). Ketiganya **tetap bisa diedit** (lewat `PUT /api/tiket/:id`, oleh admin ATAU teknisi yang di-assign ke tiket itu) selama tiket belum `DONE`/`CANCELLED` — begitu teknisi klik "Tandai Selesai", field-nya ke-lock. Halaman `/teknisi/tiket-detail` punya kartu "Jadwal & Lokasi" terpisah buat ini.

---

## 11. Rencana halaman (frontend)

```
public/
├── index.html                 → landing, pilih masuk sebagai Admin atau Teknisi
├── admin/
│   ├── login.html
│   ├── dashboard.html         → peta 3D full-screen + panel KPI/teknisi/tiket/aktivitas
│   ├── teknisi.html           → daftar & kelola akun teknisi
│   ├── tiket.html             → daftar semua tiket + filter status/priority/teknisi
│   ├── tiket-detail.html      → create/edit tiket, assign teknisi, timeline, upload bukti
│   ├── kehadiran.html         → KPI kehadiran: heatmap + detail harian + tabel ringkasan
│   └── area.html              → gambar & kelola poligon area pabrik 3D
├── teknisi/
│   ├── login.html
│   ├── home.html              → toggle online/offline, list tiket ditugaskan, kirim GPS
│   ├── tiket-baru.html        → bikin tiket sendiri (self-service, auto-assign ke diri sendiri)
│   └── tiket-detail.html      → lihat detail tiket, edit jadwal/lokasi, update progres, upload bukti
├── css/style.css
└── js/
    ├── api.js                 → wrapper fetch + simpan token
    ├── theme.js               → dark/terang mode (localStorage + toggle), di-load PALING AWAL di <head>
    ├── admin-map.js           → peta 3D dashboard (view-only) + cluster + socket listener
    ├── area-map.js            → peta 3D halaman Area Pabrik (mode gambar poligon)
    ├── calendar-heatmap.js    → kalender heatmap ala GitHub (dipakai halaman Kehadiran)
    └── teknisi-tracker.js     → geolocation watch + kirim ping tiap interval
```

---

## 12. Ringkasan endpoint API

```
POST   /api/auth/admin/login
POST   /api/auth/teknisi/login
GET    /api/auth/me

GET    /api/teknisi                     (admin, filter ?status=)
GET    /api/teknisi/:id
POST   /api/teknisi                     (admin, create akun)
PUT    /api/teknisi/:id                 (admin, edit profil/nonaktifkan)
POST   /api/teknisi/:id/status          (teknisi, ubah status sendiri)
POST   /api/teknisi/:id/location        (teknisi, ping GPS -- otomatis diklasifikasi in_area)
GET    /api/teknisi/:id/lokasi-history  (admin, trail histori)
POST   /api/teknisi/:id/area            (admin, set area kerja -- replace-all, body { area_ids: [] })

GET    /api/tiket                       (admin: semua; teknisi: query mine=1)
GET    /api/tiket/:id
POST   /api/tiket                       (admin ATAU teknisi self-service, lihat bagian 10)
PUT    /api/tiket/:id                   (admin ATAU teknisi yang di-assign, selagi belum DONE/CANCELLED)
POST   /api/tiket/:id/assign            (admin, assign/tambah teknisi)
DELETE /api/tiket/:id/assign/:teknisiId (admin, lepas teknisi dari tiket)
POST   /api/tiket/:id/status            (teknisi: IN_PROGRESS/DONE; admin: CANCELLED)
POST   /api/tiket/:id/files             (upload foto bukti)

GET    /api/dashboard/kpi
GET    /api/dashboard/monitoring        (data buat peta + aktivitas terbaru)
GET    /api/dashboard/analytics

GET    /api/area                        (admin, semua poligon area)
POST   /api/area                        (admin, bikin area baru)
PUT    /api/area/:id                    (admin, edit area)
DELETE /api/area/:id                    (admin, hapus area)

GET    /api/kpi/ringkasan?from=&to=&q=&page=      (tabel kehadiran semua karyawan, cepat/approx)
GET    /api/kpi/heatmap/:teknisiId?days=90        (data kalender heatmap, presisi)
GET    /api/kpi/harian/:teknisiId?date=YYYY-MM-DD (detail 1 hari + sesi keluar-area, presisi)
```

Socket.IO events: `register-dashboard`, `register-teknisi`, lalu server emit `teknisi-location`, `teknisi-status`, `tiket-update`.

---

## 13. Stack

- Backend: Node.js + Express + MySQL2 (pool) + JWT + bcryptjs + Socket.IO + Multer (upload foto bukti)
- Frontend: HTML/CSS/vanilla JS + MapLibre GL JS (peta 3D) + font Inter — statis, di-serve langsung dari Express.
- DB: MySQL/MariaDB, database `pt_gokak_indonesia`, semua tabel prefix `pt_kapuk_`.

## 14. Setup

```bash
npm install
cp .env.example .env      # isi DB_HOST/DB_USER/DB_PASS/JWT_SECRET/FACTORY_LAT/FACTORY_LNG
mysql -u root -p < schema.sql   # ⚠️ RESET TOTAL kalau udah pernah jalanin versi sebelumnya (tabel pt_kapuk_area/pt_kapuk_teknisi_area & kolom in_area/area_id belum ada di versi lama)
npm run dev                # http://localhost:3010
```

Akun contoh dari seed (`schema.sql`), password `password123`:
- Admin: `admin`
- Teknisi: `teknisi1`, `teknisi2`

---

## 15. Belum dibangun / ide lanjutan (sengaja di luar scope v1)

- Interval GPS `PING_INTERVAL_SECONDS` (di `helpers/kehadiran.js` + `public/js/teknisi-tracker.js`) dipatok **30 detik** dengan sengaja — sempet dicoba 2 detik biar dashboard kerasa lebih real-time, tapi dibalikin karena boros baterai HP teknisi buat manfaat yang gak sebanding. Kalau nanti beneran butuh update posisi lebih rapat (mis. buat kasus darurat), pertimbangkan interval adaptif (cepat cuma pas `ON_TASK`, lambat pas `ONLINE` biasa) daripada nyamain semua ke satu angka kecil.
- `/api/kpi/ringkasan` masih query mentah tiap request (gak ada tabel rollup harian) — cukup buat skala saat ini (500–1000 karyawan @ 30 detik), tapi kalau volume karyawan/history makin gede ke depannya, pertimbangkan tabel `pt_kapuk_kehadiran_harian` yang di-update berkala.
- Alat gambar poligon di halaman Area belum bisa drag-edit titik individual (cuma tambah/undo/bersihkan berurutan) — buat reshape, paling gampang gambar ulang dari awal.
- Push notification ke HP (FCM) saat app di background.
- Role `SUPERVISOR` read-only (kolom udah ada, pembatasan aksesnya belum).
- Riwayat/replay pergerakan teknisi di peta (data `pt_kapuk_teknisi_lokasi` sudah tersimpan, UI playback belum).
