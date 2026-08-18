# Rencana Subscription-Based License — PT Gokak Indonesia

Catatan kerja soal rencana bikin aplikasi ini jadi subscription-based
(per-user, per-tahun, ada add-on seat). Ini dokumen HIDUP — diupdate
tiap ada keputusan baru dari atasan/customer. Konteks awal: lihat
percakapan soal review atasan (subscription base, lock kalau expired,
paket 50 user/tahun + add-on per user).

---

## 1. Ringkasan keputusan yang udah dipegang

- **Model**: per-customer license, isinya jumlah seat (user) + masa
  berlaku. Contoh: 50 seat / 1 tahun, bisa nambah add-on seat per user
  di luar 50 itu.
- **Enforcement**: kalau lisensi expired → **semua login dikunci**.
  Kalau seat kepenuhan → **gak bisa nambah akun baru** (existing user
  yang udah ada tetep bisa jalan, biar gak tiba-tiba banyak yang
  kelock cuma gara-gara over-quota).
- **Hosting app**: *kemungkinan* di server customer sendiri (on-prem)
  — ini ASUMSI, BELUM FINAL. Kalau ternyata jadi SaaS (kita yang
  hosting), hampir semua masalah "proteksi source code" di dokumen ini
  otomatis hilang karena source code gak pernah nyentuh infra mereka.
  **Keputusan ini harus dikonfirmasi ke atasan sebelum lanjut ke Fase 2.**
- **Dipecah 2 fase** (jangan dipaksa selesai semua sekaligus):
  - **Fase 1 (MVP)** — skema lisensi + enforcement (expired lock, seat
    limit). Ini FITUR, achievable cepat. **→ Ini yang dikerjain sekarang.**
  - **Fase 2 (hardening)** — proteksi source code pas di-deploy ke
    server customer (obfuscation/compile ke binary/Docker/dst). Ini
    POSTUR KEAMANAN, sifatnya "makin lama makin susah dibongkar", bukan
    "selesai". Dikerjain belakangan, jangan buru-buru.

---

## 2. Arsitektur

```
┌─────────────────────────────┐         ┌──────────────────────────────┐
│  SERVER KITA (vendor)        │         │  SERVER CUSTOMER (on-prem)   │
│                               │         │                               │
│  license-private.pem  ←──────┼── RAHASIA, GAK PERNAH keluar dari sini │
│       │                      │         │                               │
│       ▼                      │         │  pt-gokak-indonesia (Docker  │
│  generate-license.js         │  kirim  │  image, kode di-obfuscate)   │
│  (tool internal, sign JWT) ──┼─license─┼──►├─ config/license-        │
│                               │  key    │  │   public.pem (AMAN       │
│                               │         │  │   di-ship, cuma verify)  │
│  vendor-license-service/     │◄────────┼──┤  license.lic (token)     │
│  (repo/infra TERPISAH,       │  check-in│ │  helpers/license.js      │
│  opsional -- aktif kalau     │  tiap    │ │   (JWT + clock anchor)   │
│  LICENSE_SERVICE_URL diisi)  │  12 jam  │ │  middleware/license.js   │
│  balikin server_time yang    │         │  │  pt_kapuk_license_state  │
│  gak bisa customer utak-atik │         │  │   (anchor jam, DB)       │
│                               │         │  │  pt_kapuk_license_      │
│  (nerima notif request       │◄────────┼──┤   requests (DB, dari    │
│  lisensi baru lewat webhook) │  webhook │  │   menu Lisensi admin)   │
└─────────────────────────────┘         └──────────────────────────────┘
```

**Kenapa asymmetric signing (RSA, bukan sekadar simpan `valid_until` di
kolom database):** kalau cuma baca tanggal dari database lokal, customer
yang PEGANG SENDIRI database-nya (di server mereka) tinggal `UPDATE`
kolomnya lewat MySQL langsung buat bypass lock. Dengan JWT yang
ditandatangani private key yang cuma kita punya, mereka bisa BACA isinya
(gak dienkripsi, cuma disign) tapi gak bisa BIKIN token baru yang valid
tanpa private key kita — mau di-edit dikit aja, tanda tangannya bakal
gak cocok lagi dan `verify()` bakal gagal.

**Library**: `jsonwebtoken` (udah jadi dependency dari awal project),
algoritma `RS256`.

---

## 3. Skema lisensi (isi token)

```json
{
  "id_mitra": "PT-GOKAK",
  "customer": "PT Gokak Indonesia",
  "base_seats": 50,
  "addon_seats": 0,
  "iat": 1755129600,
  "exp": 1786665600
}
```

- `id_mitra` = kode pendek unik PER INSTALASI (ditentukan vendor pas
  `register-partner.js`, bukan customer yang pilih). Kalau env
  `ID_MITRA` diisi di `.env` instalasi customer, app WAJIB nyocokin ini
  ke nilai env-nya sebelum lisensi dianggap valid — lihat bagian 10-F.
  `customer` tetap ada terpisah SEBAGAI NAMA TAMPILAN (dashboard,
  halaman lock), gak dipakai buat validasi apapun.
- `exp` = klaim bawaan JWT, otomatis divalidasi sama `jsonwebtoken.verify()`
  (lempar `TokenExpiredError` kalau udah lewat) — gak perlu logic manual.
- `total_seats = base_seats + addon_seats`, dihitung pas verifikasi,
  bukan disimpan terpisah (biar gak ada 2 sumber kebenaran).
- **Nambah add-on** = generate ULANG token (isi `addon_seats` baru,
  `exp` bisa dipertahanin sama), kirim token baru ke customer. **Cara
  pasangnya SEKARANG lewat dashboard** — admin tempel token itu di menu
  🔑 Lisensi (atau halaman lock kalau kebetulan lagi expired), klik
  Aktifkan, LANGSUNG kepake tanpa restart service & tanpa akses
  SSH/file server (`POST /api/license/activate`, lihat bagian 10-E).
  (Fallback teknis lama masih ada & tetap jalan: taruh manual di
  `license.lic` / isi env `LICENSE_KEY` lalu restart — cuma bukan lagi
  cara utama.)
- **Perpanjang masa aktif** = generate ulang token juga, isi cuma `exp`
  yang beda, cara pasangnya sama kayak poin di atas.

**Yang dihitung sebagai "seat"**: total akun AKTIF (`is_active=1`) di
`pt_kapuk_teknisi` — BUKAN admin. Asumsi: yang dijual itu "per
karyawan/teknisi yang dipantau", akun admin cuma buat ops internal
mereka, jumlahnya biasanya kecil & gak masuk hitungan komersial. **Ini
asumsi bisnis, bukan keputusan teknis — konfirmasi ke atasan, gampang
diubah kalau ternyata admin juga mau dihitung** (satu tempat ganti di
`helpers/license.js`, fungsi `countUsedSeats()`).

---

## 4. Flow serah terima ke customer

1. Kita **build versi production** app (Fase 2: di-compile/obfuscate,
   bukan `git clone` mentah ke server mereka).
2. Kita **generate license key pertama** sesuai kontrak (misal 50 seat,
   1 tahun) pakai `licensing-tools/generate-license.js` (tool internal,
   private key TETAP di server/laptop kita, gak ikut dikirim).
3. Kita kirim ke customer (lihat detail lengkap di bagian 6):
   paket aplikasi, license key, dokumentasi instalasi, kredensial admin
   awal.
4. Bantu instalasi awal (remote/onsite): isi `.env` (kredensial DB,
   `JWT_SECRET`, dll), `docker compose up`. Skema database **kebentuk
   OTOMATIS** (lihat `scripts/migrate.js`, dijalanin duluan sama
   Dockerfile sebelum server-nya nyala — customer/kita GAK PERLU
   jalanin `schema.sql` manual lagi). Lisensi masih KOSONG di titik ini
   — login admin pakai akun default dari seed schema.sql, tempel
   license key yang udah digenerate di poin 2 lewat menu 🔑 Lisensi /
   halaman lock begitu dashboard kebuka (lihat bagian 10-E), baru
   testing login & fitur inti selesai.
5. **Serah terima resmi (BAST)** — dokumentasi tertulis bahwa sistem
   sudah jalan & sudah dites, ditandatangani 2 pihak. Ini juga tempat
   yang pas buat nulis klausul larangan modifikasi/reverse-engineer
   source code (proteksi LEGAL, pelengkap proteksi teknis — gak ada
   satupun proteksi teknis yang bisa gantiin kontrak yang jelas).
6. Support & monitoring lisensi mulai jalan dari titik ini (lihat
   bagian 5 — pantau H-30 sebelum expired biar bisa follow-up sales
   duluan sebelum customer kelock mendadak).

---

## 5. Flow operasional subscription (hari-hari biasa)

**Perpanjang tahunan / beli add-on seat:**
1. Customer hubungi kita (sales/support) — mau perpanjang atau nambah
   seat.
2. Kita update catatan lisensi customer itu (base_seats/addon_seats/
   masa aktif baru).
3. Generate ULANG license key (`generate-license.js`), kirim ke
   customer.
4. Admin customer LOGIN ke dashboard (login SELALU bisa, terlepas dari
   status lisensi lama — lihat bagian 10-E), buka menu 🔑 Lisensi,
   tempel token barunya, klik Aktifkan. **Langsung aktif saat itu juga**
   (`POST /api/license/activate` nulis ulang `license.lic` + paksa
   re-verify, gak nunggu cache 5 menit & gak perlu restart service sama
   sekali). Gak perlu lagi akses `.env`/SSH ke server customer.

**Lisensi mau habis:**
- Karena verifikasi kita rancang **offline** (baca file/token lokal,
  gak butuh internet ke server kita — lihat batasan di bagian 9), gak
  ada notifikasi otomatis ke KITA kalau lisensi customer mau abis.
  **Kita yang harus rutin cek** tanggal expired tiap customer (spreadsheet
  sederhana dulu cukup) dan follow-up sebelum H-0. Di app sendiri, admin
  bakal liat banner "Lisensi berakhir dalam N hari" begitu H-30 (dari
  `GET /api/license/status`, sudah dibangun di Fase 1).

**Lisensi expired & gak diperpanjang:**
- Semua login (`/api/auth/*/login`) otomatis ditolak sama middleware,
  pesannya jelas: "Lisensi sudah berakhir, hubungi PT [kita] untuk
  perpanjangan." Data customer TETAP AMAN di database mereka (kita gak
  hapus apa-apa) — begitu lisensi baru dipasang, langsung jalan normal
  lagi.

---

## 6. Yang perlu DIBERIKAN ke customer

- [x] Paket aplikasi versi production — **Docker image**, dibangun dari
      `Dockerfile` (multi-stage: stage builder jalanin `npm run build`
      yang meng-obfuscate `routes/helpers/middleware/socket.js` pakai
      `javascript-obfuscator`, stage runtime cuma isi hasil obfuscate +
      `node_modules` production + `public/` — source asli TIDAK ikut).
- [x] `LICENSE_KEY` / `license.lic` (string token, hasil dari
      `generate-license.js`).
- [ ] Dokumentasi instalasi (`.env` apa aja yang wajib diisi, cara
      jalanin `schema.sql`, cara start service) — **terpisah dari
      README dev**, gak perlu expose detail arsitektur internal. Bisa
      pakai `docker-compose.yml` yang udah ada sebagai contoh + narasi
      singkat.
- [ ] Kredensial admin awal (1x pakai, minta ganti password pas login
      pertama).
- [ ] Kontak support buat renewal/add-on/laporan bug (`VENDOR_SUPPORT_EMAIL`
      di `.env`, ditampilin di halaman `/license-locked` & menu Lisensi).
- [ ] (Kalau ada) dokumen kontrak/BAST yang udah ditandatangani.

## 7. Yang perlu DISETUP CUSTOMER di server mereka

- [x] Docker Engine + `docker-compose` (lihat `docker-compose.yml`
      contoh) — TIDAK perlu Node.js terinstall langsung di host, semua
      dependency ada di dalam image.
- [ ] MySQL/MariaDB server sendiri (data mereka, mereka yang backup) —
      SENGAJA TIDAK di-containerize bareng app, biar data & backup
      tetap sepenuhnya di kontrol customer.
- [ ] Isi `.env`: kredensial DB mereka, `JWT_SECRET`, koordinat pabrik
      (`FACTORY_LAT`/`FACTORY_LNG`). **`LICENSE_KEY` TIDAK PERLU diisi
      manual lagi** — lisensi dipasang belakangan lewat dashboard (lihat
      bagian 10-E), env itu sekarang cuma fallback teknis buat
      dev/testing.
- [x] ~~Jalanin `schema.sql` sekali di awal~~ — **OTOMATIS**, `docker
      compose up` udah nge-trigger `scripts/migrate.js` yang bikin
      skema (11 tabel) + akun admin default kalau DB-nya masih kosong,
      SKIP kalau udah pernah (gak akan nge-reset data yang udah ada).
      Customer/kita gak perlu jalanin perintah SQL manual sama sekali.
- [ ] Reverse proxy + SSL (nginx/caddy) kalau mau diakses via domain
      sendiri dari luar server — di luar tanggung jawab kita kecuali
      diminta bantu setup. **Port yang dipakai TIDAK memengaruhi
      enforcement lisensi** — middleware lisensi gak pernah baca/peduli
      `process.env.PORT`, jadi ganti-ganti port gak ngefek apa-apa ke
      status lisensi (sudah dites jalan identik di banyak port berbeda).
- [ ] Backup rutin database mereka sendiri (di luar scope aplikasi ini).
- [ ] *(Opsional, direkomendasikan)* akses jaringan OUTBOUND ke
      `LICENSE_SERVICE_URL` (vendor-license-service kita) — kalau diisi,
      nutupin celah clock-rollback yang dijelasin di bagian 9. Kalau gak
      ada internet/gak diisi, app tetap jalan normal cuma pakai deteksi
      jam mundur LOKAL (lebih lemah tapi tetap ada, bukan nol).

## 8. Yang perlu KITA (vendor) setup

- [x] Generate RSA keypair (`license-private.pem` / `license-public.pem`)
      — **private key gak boleh pernah ikut ke-commit atau ke-ship**.
- [ ] Simpan private key di tempat aman (bukan di laptop biasa doang,
      idealnya password manager/secret store).
- [ ] Catatan customer & lisensi (spreadsheet dulu cukup buat awal):
      nama customer, seat, tanggal mulai/berakhir, riwayat perpanjangan.
- [ ] Proses/SOP internal: siapa yang boleh generate license key,
      gimana cara follow-up H-30 sebelum expired, DAN siapa yang pantau
      `GET /api/license/requests` / webhook (customer minta add-on/
      renewal lewat menu Lisensi mereka sendiri sekarang, lihat bagian 10).
- [x] Pipeline build buat compile/obfuscate app sebelum dikirim ke
      customer (`npm run build` → `scripts/build-obfuscate.js` →
      `Dockerfile`) — jangan pernah `git clone` mentah ke server mereka.
- [x] **Kode** License Service kecil (`vendor-license-service/`) buat
      verifikasi online berkala — nutupin celah "customer majuin/
      mundurin jam server" di bagian 9. **BELUM di-hosting beneran**
      (butuh server/domain/SSL milik vendor, di luar kapasitas coding
      session ini) — begitu ada infra, tinggal deploy folder ini
      TERPISAH dari repo project ini & isi `LICENSE_SERVICE_URL` di
      `.env` customer.

---

## 9. Batasan & resiko yang perlu disadari (jangan di-oversell ke atasan)

**Hukum dasar yang gak bisa ditawar**: gak ada software yang bisa dibikin
100% gak bisa diutak-atik kalau dia jalan di hardware yang SEPENUHNYA
dikontrol pihak lain (akses root/admin) — termasuk kalau pihak itu pakai
AI buat bantu reverse-engineer. Ini bukan keterbatasan kemampuan kita,
ini hukum keamanan komputer secara umum (fisik + akses penuh selalu bisa
menang lawan proteksi software murni, cepat atau lambat). Yang REALISTIS
dikejar: **lapisan proteksi berlapis yang menaikkan biaya & keahlian yang
dibutuhkan buat bypass**, sampai titik di mana secara praktis gak worth
it buat customer coba-coba (lebih mahal/ribet daripada bayar lisensi
resmi) — DITAMBAH backstop kontrak/legal yang gak bisa ditembus teknis
sama sekali. Berikut rincian tiap lapisan & batasannya masing-masing:

- **Lapisan kode (obfuscation, `javascript-obfuscator`)**: menyulitkan
  BACA & MODIF kode secara manual/otomatis (control flow flattening,
  dead code injection, string array ter-encode, `selfDefending` biar
  hasil obfuscate-nya rusak sendiri kalau di-reformat/di-prettify).
  **BUKAN enkripsi** — dijalankan sebagai JS biasa sama Node, jadi
  secara prinsip tetap bisa dibaca ulang (deobfuscator ada, AI juga bisa
  bantu, cuma jauh lebih lambat & makan waktu/biaya). Ini yang bikin
  "berat", bukan yang bikin "mustahil".
- **Lapisan distribusi (Docker image)**: source code ASLI (belum
  di-obfuscate) gak pernah ikut terkirim ke server customer — cuma hasil
  build yang ada. Tapi begitu image itu di-`docker run`, isinya tetap
  bisa di-`docker exec` masuk & dibaca dari dalam kalau orangnya punya
  akses ke Docker daemon di server itu (root/sudo). Sama kayak poin di
  atas: lebih susah, bukan mustahil.
- **Lapisan lisensi (JWT RS256)**: gak bisa dipalsuin TANPA private key
  kita (itu udah kuat & gak ada celah kriptografi yang diketahui). Tapi
  verifikasinya jalan DI MESIN CUSTOMER — kalau mereka edit
  `helpers/license.js` hasil obfuscate langsung (misal bikin fungsi
  `verifyLicense` selalu `return {valid:true}`), itu bukan soal
  kriptografi lagi, itu soal APAKAH mereka bisa nemu & ngedit baris yang
  tepat di kode yang udah diobfuscate — makanya lapisan obfuscation +
  Docker di atas itu penting, bukan basa-basi.
- **Lapisan jam sistem — SEKARANG ADA 2 TINGKAT**:
  1. **Deteksi jam mundur LOKAL** (`checkClockIntegrity` di
     `helpers/license.js`, tabel `pt_kapuk_license_state`) — SELALU
     aktif, gak butuh internet. Nyimpen jam TERBESAR yang pernah keliatan
     (monoton), kalau jam sekarang lebih kecil dari itu (di luar
     toleransi 2 menit buat jitter wajar) → langsung dianggap lisensi
     gak valid apapun kata `exp` JWT-nya. **Sudah dites**: mundurin jam
     + fresh cache → login ketolak dengan pesan `CLOCK_TAMPERED`.
     **Celah yang JUJUR harus diakui**: orang yang tau caranya (akses DB
     + tau nama tabelnya) bisa `DELETE`/reset baris itu BARENGAN mundurin
     jam, jadi "jangkarnya" ikut ke-reset juga. Ini nutupin serangan
     PALING GAMPANG (sekadar ubah jam lewat Control Panel/`date`), bukan
     serangan tercanggih.
  2. **Phone-home ONLINE ke `vendor-license-service`** (`helpers/phone-
     home.js`, opsional lewat `LICENSE_SERVICE_URL`) — INI yang nutupin
     celah di atas, karena jam yang dipakai buat nge-set ulang jangkar
     datang dari MESIN VENDOR yang customer gak kontrol sama sekali,
     bukan dari jam lokal mereka. **Sudah dites end-to-end** (main app +
     `vendor-license-service` jalan bareng di 2 port beda, check-in
     sukses, jangkar DB ke-update sesuai `server_time` dari servis
     vendor). **TAPI**: fitur ini baru "siap secara kode", BELUM aktif
     di produksi manapun karena butuh hosting sungguhan (server/domain/
     SSL) milik vendor yang belum diplot — sampai itu ada, semua
     instalasi customer cuma dapat proteksi tingkat 1 di atas. Kalau
     internet customer mati/servis vendor down, phone-home GAGAL DIAM-
     DIAM (gak ikut nge-lock lisensi gara-gara itu — lihat kebijakan
     grace period yang masih perlu diputus di bagian 10-A) — jadi ini
     murni lapisan TAMBAHAN, bukan satu-satunya penjaga.
- **Gak ada proteksi source code yang 100% gak bisa dibongkar** kalau
  aplikasinya jalan di server yang mereka kontrol penuh (root access) —
  ini konsekuensi langsung dari "hukum dasar" di atas, bukan sesuatu
  yang bisa "diperbaiki" dengan teknik tambahan apapun. Backstop yang
  SEBENARNYA menutup celah ini adalah kontrak/legal (bagian 4, poin 5),
  bukan teknis — pastikan klausul larangan reverse-engineer & sanksinya
  jelas di BAST/kontrak.
- **Seat cuma dihitung dari teknisi aktif** (lihat bagian 3) — kalau
  bisnisnya ternyata mau hitung admin juga, gampang diubah tapi perlu
  dikonfirmasi dulu, jangan asumsi sepihak.
- **Kalau customer punya banyak server/lingkungan** (staging+production
  misalnya) dengan 1 license key yang sama, gak ada proteksi "1 license
  = 1 mesin" (belum ada machine-fingerprint binding, lihat bagian
  10-D — sengaja belum dibikin, prioritas rendah sampai ada kebutuhan
  konkret).

---

## 10. Roadmap fase

### Fase 1 — MVP (SELESAI, sudah diimplementasi & dites)
- [x] Dokumen ini (`notesubscribe.md`).
- [x] RSA keypair generator (`licensing-tools/generate-keypair.js`) — udah dijalanin sekali, keypair ada di `licensing-tools/keys/` (gitignored) + `config/license-public.pem` (aman di-ship).
- [x] License generator (`licensing-tools/generate-license.js`) — dites bikin token buat 50 seat/1 tahun, hasil tokennya valid & bisa diverifikasi.
- [x] `helpers/license.js` — verifikasi token (RS256) + hitung seat terpakai dari `pt_kapuk_teknisi` aktif. Dites: token valid ✅, token di-tamper ✅ ketolak, token expired ✅ ketolak.
- [x] `middleware/license.js` — blok semua `/api/*` (kecuali `/api/license/status` & `/health`) kalau lisensi invalid/expired. Dipasang di `server.js`.
- [x] `routes/license.route.js` — `GET /api/license/status` (publik, gak butuh login, gak kena gerbang lisensi).
- [x] Enforce seat limit di `POST /api/teknisi` (bikin baru) & `PUT /api/teknisi/:id` (reaktivasi dari nonaktif).
- [x] Banner peringatan H-30 di dashboard admin (`public/js/license-banner.js`) + halaman blokir full-screen `public/license-locked.html` (otomatis diarahkan ke sini dari halaman manapun kalau ada API call kena 403 lisensi, lihat `api.js`). Halaman login sendiri nunjukin pesannya inline, gak redirect.
- [x] `.env.example` + `.gitignore` (private key & `license.lic` di-ignore, public key TETAP di-track).
- [x] License contoh (dev/testing, 50 seat/1 tahun) di-generate lokal, disimpan di `license.lic` (gitignored) buat coba-coba di server dev.

**Catatan hasil testing**: verifikasi di-cache 5 menit (`CACHE_TTL_MS` di `helpers/license.js`) biar gak baca file/re-verify tiap request -- jadi kalau ganti/hapus `license.lic` pas lagi testing manual, efeknya BARU KELIATAN maksimal 5 menit kemudian (bukan instan), atau restart service buat langsung kepake.

**Bug yang ketemu & udah diperbaiki pas demo/testing:**
- Gerbang lisensi awalnya dipasang `app.use(requireValidLicense)` TANPA prefix path, efeknya ikut nge-block halaman statis (`/admin/login`, `/license-locked`, bahkan `/css/style.css`) -- padahal itu justru yang harus tetap kebuka biar halaman bisa NUNJUKIN pesan errornya. Fixed: di-scope jadi `app.use('/api', requireValidLicense)` di `server.js`, jadi cuma endpoint API bisnis yang keblokir, halaman & aset statis tetap normal.
- Sudah didemoin ulang & dikonfirmasi: skenario **kuota seat penuh** (bikin akun ke-N gagal dengan pesan jelas) dan skenario **lisensi expired** (login baru ditolak, sesi admin LAMA yang tokennya masih valid pun ikut keblokir begitu lisensi invalid, halaman statis tetap kebuka) — dua-duanya jalan sesuai desain, dites lewat instance server terpisah (port beda) biar gak ganggu server dev yang lagi jalan.

### Fase 2 — Hardening (SELESAI level kode, per arahan "selesaikan
semua fase" — instruksi lengkap & terjemahannya dicatat di bagian 11)

Dipecah kelompok, biar jelas mana yang nunggu keputusan orang lain,
mana yang butuh infra baru (bukan cuma coding), dan mana yang sudah
selesai dikerjain sekarang.

#### A. Keputusan (masih blocking untuk BEBERAPA hal, dicatat sebagai asumsi kerja)
- [ ] **SaaS vs on-prem — masih BELUM final dikonfirmasi ke atasan.**
      Karena diarahkan buat "selesaikan semua fase sekarang", saya
      lanjut pakai **asumsi kerja: on-prem** (bagian B, C, D di bawah
      semuanya relevan buat skenario ini). Kalau ternyata jadi SaaS,
      bagian obfuscation/Docker/phone-home jadi gak terlalu perlu (kode
      gak pernah nyentuh server customer) — tapi kode yang udah dibikin
      TETAP AMAN dipakai/tidak dipakai, gak ada yang perlu dibongkar.
      **Tetap perlu dikonfirmasi ke atasan**, cuma bukan lagi hal yang
      menghentikan progres.
- [x] **Kebijakan "gak ada internet"**: diputuskan pakai rekomendasi
      sendiri (grace period, bukan langsung kunci) — kalau
      `LICENSE_SERVICE_URL` gagal dihubungi (internet mati/servis vendor
      down), `helpers/phone-home.js` DIAM-DIAM gagal (cuma
      `console.error`, gak nyentuh status lisensi sama sekali) & app
      tetap jalan normal pakai deteksi jam mundur LOKAL. Gak ada
      collateral lock gara-gara jaringan bermasalah.

#### B. Infrastruktur & packaging — SELESAI, sudah dites
- [x] Dockerize aplikasi (multi-stage build, `Dockerfile`): stage
      `builder` install dependency + jalanin `npm run build`
      (`scripts/build-obfuscate.js`, pakai `javascript-obfuscator` —
      controlFlowFlattening, deadCodeInjection, stringArray base64,
      identifier hexadecimal, selfDefending; SENGAJA gak matiin
      console output biar vendor tetap bisa debug lewat `docker logs`,
      SENGAJA gak rename global biar `require()` gak rusak) ke
      `routes/helpers/middleware/socket.js` + `server.js`, stage
      `runtime` (`node:20-alpine`) isinya cuma hasil `dist/` + `node_modules`
      production + `public/` — source asli TIDAK ikut ke image.
- [x] `.dockerignore` — `licensing-tools/`, `.git`, `license.lic`,
      `.env`, `dist/`, `vendor-license-service/` semua dikecualikan
      dari build context, gak mungkin ke-bundle ke image customer.
- [x] `docker-compose.yml` CONTOH buat customer (app + `extra_hosts:
      host.docker.internal:host-gateway` biar bisa connect ke MySQL di
      host Linux, volume `uploads`) — MySQL SENGAJA TIDAK ikut
      di-containerize bareng, biar data & backup tetap sepenuhnya di
      kontrol customer. **Revisi**: `license.lic` awalnya di-bind-mount
      READ-ONLY dari host — ternyata KONFLIK sama fitur aktivasi lewat
      dashboard (bagian 10-E, yang perlu NULIS file itu dari dalam
      container). Diganti jadi named volume `license_data` (writable,
      tetap PERSISTEN lintas restart/update container) + env
      `LICENSE_FILE=/app/license-data/license.lic`.
- [x] `scripts/migrate.js` — dipanggil Dockerfile (`CMD`) sebelum
      `node server.js`, bikin skema DB otomatis kalau kosong (lihat
      bagian 7). **Bug ketemu & diperbaiki saat testing**: `schema.sql`
      HARDCODE nama database `pt_gokak_indonesia` di statement `CREATE
      DATABASE`/`USE`-nya — kalau customer isi `DB_NAME` lain di `.env`,
      tanpa perbaikan migrasi bakal diam-diam kebentuk di database yang
      SALAH (bukan yang dipakai app lewat `db.js`). Fixed dengan
      substitusi literal nama DB di teks SQL sebelum dieksekusi
      (`sql.replace(/pt_gokak_indonesia/g, DB_NAME)`). Dites 2 skenario:
      DB custom name kosong → 11 tabel + seed admin kebentuk benar di
      nama itu; DB yang UDAH ADA isinya → di-SKIP (gak nge-reset data).
- [x] Uji: `node scripts/build-obfuscate.js` menghasilkan `dist/` yang
      valid, `node dist/server.js` jalan normal (nyambung ke
      `node_modules` di parent dir) — obfuscation TERBUKTI gak merusak
      fungsionalitas. Uji `docker build` sungguhan BELUM bisa dijalankan
      di environment coding ini (Docker gak terpasang), tapi logic
      Dockerfile udah diverifikasi manual lewat alur obfuscate+run yang
      sama persis.

#### C. License Service online / phone-home — SELESAI level kode, BELUM di-hosting
- [x] Dibikin di folder `vendor-license-service/` — **struktur & dependency
      SENGAJA dipisah** (`package.json` sendiri, `private: true`,
      deskripsi eksplisit "INTERNAL VENDOR ONLY, harus dihosting
      terpisah") biar gampang dipindah ke repo git sendiri kapan pun
      infra hosting-nya siap, dan `.dockerignore` project utama udah
      mastiin folder ini gak pernah ke-bundle ke image customer. Isinya:
      `POST /checkin` (terima `license_key`, verifikasi tanda tangan RS256
      pakai public key yang sama, balikin `{ ok, server_time,
      signature_valid, expired }`), `GET /checkins` (daftar customer &
      kapan terakhir check-in, dilindungi header `x-admin-key` opsional),
      `GET /health`.
- [ ] Hosting buat service ini (server/subdomain/SSL milik vendor) —
      KEBUTUHAN INFRA, bukan cuma kode, di luar kapasitas sesi coding
      ini (gak ada kredensial cloud/hosting). **Ini satu-satunya item
      Fase 2 yang beneran nunggu tindakan MANUSIA, bukan nunggu
      keputusan/kode.**
- [x] Logic di app (`helpers/phone-home.js`, opsional lewat env
      `LICENSE_SERVICE_URL` — kosong = fitur mati total, gak ada
      perilaku yang berubah buat instalasi existing): check-in tiap 12
      jam (`CHECKIN_INTERVAL_MS`) + langsung sekali pas startup, ambil
      `server_time` dari respons, panggil `bumpClockAnchor()` di
      `helpers/license.js` buat nge-set ulang jangkar jam
      (`pt_kapuk_license_state`) pakai waktu vendor itu — GREATEST
      dengan nilai lama, jadi gak bisa dipakai buat MUNDURIN jangkar,
      cuma buat majuin/samain ke waktu asli.
- [x] **Dites end-to-end**: `vendor-license-service` dijalanin di 1
      port, app utama di port lain dengan `LICENSE_SERVICE_URL` diisi
      nunjuk ke situ — check-in sukses, `GET /checkins` di sisi vendor
      nunjukin data customer yang benar, `pt_kapuk_license_state` di DB
      app ke-update persis sama `server_time` yang dibalikin vendor.
      Juga dites: `LICENSE_SERVICE_URL` kosong (default) → log
      `[PHONE-HOME] ... nonaktif`, gak ada request keluar, gak ada
      error.
- [x] Kebijakan grace period — lihat bagian A di atas, sudah diterapkan
      di kode (gagal connect = diabaikan, bukan dikunci).

#### D. Opsional / prioritas rendah — SENGAJA BELUM dikerjakan
- [ ] Machine-fingerprint binding (1 license = 1 mesin) — baru relevan
      kalau ada kekhawatiran spesifik soal 1 license dipakai di banyak
      server sekaligus. Nambah kerumitan di sisi "customer pindah
      server yang sah" (perlu proses re-binding), jadi jangan dibikin
      kalau belum ada kebutuhan konkret.

#### E. Fitur menu Lisensi admin — SELESAI, sudah dites (di luar 3 kelompok asli, ditambah karena diminta eksplisit: "ada halaman/menu license untuk lihat detail license... atau request license baru")
- [x] `GET /api/license/status` (publik, sudah ada dari Fase 1, sekarang
      juga balikin `app_version` dari file `VERSION`) — dipakai halaman
      Lisensi buat nunjukin customer, jumlah seat (base+addon+terpakai),
      tanggal berlaku s/d, sisa hari.
- [x] `POST /api/license/request` (publik, rate-limited per-IP pakai
      `Map` in-memory) — form isi tipe (`ADDON`/`RENEWAL`/`OTHER`),
      jumlah seat diminta, catatan, kontak — kesimpen ke tabel
      `pt_kapuk_license_requests`, DAN kalau `VENDOR_REQUEST_WEBHOOK_URL`
      diisi, langsung di-POST juga ke situ (fire-and-forget, gagal kirim
      webhook TIDAK menggagalkan penyimpanan ke DB — DB tetap jadi
      sumber kebenaran/audit trail utama).
- [x] `GET /api/license/requests` (`requireAuth` + `requireAdmin`) —
      riwayat 50 request terakhir, buat admin customer pantau status
      pengajuan mereka sendiri.
- [x] **`app.use('/api/auth', authRoute)` dipindah ke SEBELUM gerbang
      lisensi di `server.js`** — perubahan arsitektur penting: login
      (admin & teknisi) SEKARANG SELALU bisa, terlepas dari status
      lisensi. Sebelumnya login ikut keblokir kalau lisensi invalid,
      yang bikin admin gak PUNYA JALAN buat masuk dashboard & masang
      lisensi baru sama sekali tanpa akses file server. Endpoint
      bisnis lain (`/api/teknisi`, `/api/tiket`, dst) TETAP kena
      gerbang seperti biasa — cuma login-nya yang dikecualikan.
- [x] `POST /api/license/activate` (`requireAuth` + `requireAdmin`,
      didaftarin di `routes/license.route.js` yang emang udah di luar
      gerbang lisensi) — admin tempel token baru, `activateLicense()`
      di `helpers/license.js` verifikasi tanda tangannya DULU
      (`ignoreExpiration:true`, jadi token yang KEBETULAN udah expired
      pun tetap "valid" buat ditulis — validasi expired itu urusan
      `verifyLicense()` normal belakangan, bukan gerbang tulis-file
      ini), baru ditulis ke `license.lic` + cache lisensi dipaksa
      refresh. **Aktif SAAT ITU JUGA, gak perlu restart service &
      gak nunggu cache TTL 5 menit.**
- [x] Halaman `public/admin/license.html` — menu "🔑 Lisensi" di sidebar
      SEMUA halaman admin, isinya status lisensi aktif + card "Pasang
      Token Lisensi Baru" (activate) + form ajukan request + riwayat
      request.
- [x] `public/license-locked.html` — form request (publik, gak perlu
      login) TETAP ada buat kasus SaSS makna lain, TAPI SEKARANG kalau
      halaman ini kedetect ada token admin di `localStorage` (artinya
      admin BERHASIL login meski lisensinya invalid — lihat poin login
      di atas), muncul JUGA form "tempel token" yang manggil
      `POST /api/license/activate` — jadi flow lengkapnya: **lisensi
      kosong/expired → admin tetap bisa login → coba buka halaman lain
      kena 403 → dilempar ke halaman ini → tempel token di sini →
      langsung kebuka semua fitur, redirect otomatis ke dashboard.**
      Ini PERSIS alur yang diminta di instruksi asli (bagian 11).
- [x] **Dites end-to-end** (simulasi instalasi baru — `license.lic`
      dihapus dulu): `GET /api/license/status` → `NO_LICENSE`; login
      admin → SUKSES (token JWT keluar) walau lisensi invalid;
      endpoint lain (`GET /api/teknisi`) → 403 `licenseError`; kirim
      token asal/ngaco ke `/api/license/activate` → ditolak dengan
      pesan jelas, `license.lic` LAMA gak ikut rusak; kirim token
      ASLI yang valid → sukses, `GET /api/teknisi` yang tadinya 403
      LANGSUNG jadi 200 di request berikutnya tanpa restart apapun.

#### F. Binding `id_mitra` + dokumentasi instalasi — SELESAI, sudah dites (ringan tapi bikin ngincer 10-D lebih konkret, ditambah atas permintaan eksplisit)
- [x] `licensing-tools/register-partner.js` (tool vendor) — registry
      lokal `licensing-tools/partners.json` (**DI-GITIGNORE, cuma ada
      di laptop vendor, gak pernah ke-commit** — ini yang dimaksud
      "terdaftar di PC saya"). `--id KODE --name "Nama"` buat
      daftar/update, `--list` buat lihat semua, `--revoke KODE` buat
      nonaktifkan (gak bisa generate token BARU buat id itu lagi, token
      LAMA yang udah kepasang customer TETAP jalan sampai `exp`-nya).
- [x] `licensing-tools/generate-license.js` sekarang WAJIB `--id` yang
      SUDAH terdaftar di registry itu — nolak generate (exit code 1,
      pesan jelas) kalau id belum didaftarkan atau udah di-revoke.
      Payload token nambah field `id_mitra` (lihat bagian 3).
- [x] `helpers/license.js` — `checkIdMitra()`, OPT-IN lewat env
      `ID_MITRA` di `.env` instalasi customer (kosong = skip total,
      gak ada perubahan perilaku buat instalasi lama/dev — pola yang
      sama kayak `LICENSE_SERVICE_URL`). Kalau diisi, `payload.id_mitra`
      WAJIB sama persis (case-insensitive) — beda dikit aja ditolak
      dengan reason baru `ID_MITRA_MISMATCH`, walau tanda tangan
      tokennya sah. Dicek di 2 tempat: `verifyLicenseRaw()` (validasi
      normal tiap request) DAN `activateLicense()` (biar token yang
      SALAH INSTALASI ditolak SEBELUM nimpa `license.lic` yang lama,
      gak ikut ngerusak lisensi yang mungkin masih valid).
- [x] **Dites 3 skenario** langsung lewat `helpers/license.js`: token
      + `ID_MITRA` yang SAMA → valid; token + `ID_MITRA` yang BEDA →
      `ID_MITRA_MISMATCH`; `ID_MITRA` gak diisi sama sekali → tetap
      valid (opt-in mati, backward compatible). Juga dites
      `generate-license.js` nolak id yang belum terdaftar & id yang
      udah di-revoke, masing-masing exit code 1 dengan pesan panduan.
- **Batasan jujur** (konsisten sama bagian 9): ini BUKAN machine-
  fingerprinting sungguhan (10-D) — cuma nyocokin STRING yang
  DIKONFIGURASI, bukan identitas hardware. Orang yang punya akses ke
  `.env` DAN tau isi token vendor bisa aja tetap comot & pasang di
  instalasi lain, asal ID_MITRA-nya juga disesuaikan manual. Yang
  ditutup cuma skenario PALING UMUM: `license.lic` KETUKAR/ke-copy gak
  sengaja antar instalasi, atau dipasang di instalasi yang gak
  ditujukan (customer beda dari yang di kontrak). Machine-fingerprint
  beneran (kalau suatu saat dibutuhin) tetap ngincer 10-D, belum
  dikerjain.
- [x] `INSTALL-CUSTOMER.md` (baru, di root project) — panduan 2 sisi:
      checklist VENDOR (register partner, siapkan `.env` per customer,
      build/kirim image, generate token pertama) + langkah INSTALLER
      (`docker compose up`, login default `admin`/`password123` WAJIB
      diganti, aktivasi lisensi lewat dashboard) + tabel troubleshooting
      singkat. Dipisah dari `notesubscribe.md` (itu dokumen KEPUTUSAN &
      alasan desain, ini dokumen LANGKAH PRAKTIS) — dikecualikan dari
      `.dockerignore` juga (dokumentasi, bukan runtime).

#### G. Menu "Kelola Mitra" (Fase 3, bukan lagi Fase 2 — instruksi baru, dicatat verbatim di bagian 12) — SELESAI, sudah dites
- [x] **Instalasi ini (port 3010, dijalanin `npm run dev`/`npm start`
      langsung dari source) sekarang berperan sebagai "MASTER vendor"**
      — diaktifkan lewat `VENDOR_MASTER_MODE=true` di `.env` (SUDAH
      di-set di `.env` lokal ini). Env ini SATU-SATUNYA saklar fitur
      "Kelola Mitra" — kalau `false`/gak diisi (default di semua
      instalasi lain termasuk customer), fitur ini nonaktif total.
- [x] `licensing-tools/lib/issue-license.js` (baru) — lib bersama yang
      ngerangkum SEMUA logic "nerbitin lisensi buat 1 mitra": registry
      (`loadRegistry`/`saveRegistry`/`registerOrUpdatePartner`/
      `revokePartner`), generate token (`generateLicenseToken`), DAN
      scaffold paket Docker (`scaffoldDockerPackage`). **Dipakai
      BARENGAN** oleh CLI (`register-partner.js`, `generate-license.js`
      — sekarang jadi wrapper tipis, gak ada logic dobel lagi) DAN web
      (`routes/mitra.route.js`) — inilah bagian "rapihin struktur" yang
      diminta: sebelumnya 2 CLI script masing-masing punya salinan
      logic sendiri, sekarang 1 sumber kebenaran.
- [x] `routes/mitra.route.js` (baru, **VENDOR-ONLY**) — `GET /api/mitra`
      (daftar), `POST /api/mitra` (bikin mitra baru: registrasi + token
      + scaffold folder sekali jalan), `POST /api/mitra/:id/reissue`
      (renewal/nambah seat, `JWT_SECRET` instalasi LAMA di folder itu
      DIPERTAHANKAN — **bug ketemu & diperbaiki saat testing**: awalnya
      `scaffoldDockerPackage` SELALU generate `JWT_SECRET` acak baru
      tiap dipanggil, termasuk pas reissue, padahal pesannya udah
      ngeklaim "dipertahankan" — fixed dengan `readExistingJwtSecret()`
      yang baca `.env` lama di folder itu dulu sebelum generate yang
      baru), `POST /api/mitra/:id/revoke`. Didaftarkan di `server.js`
      HANYA kalau `VENDOR_MASTER_MODE=true`, dibungkus try/catch supaya
      kalau file ini gak ada (situasi NORMAL di image customer) app
      TETAP jalan, cuma nge-log peringatan.
- [x] `public/admin/mitra.html` (baru, **VENDOR-ONLY**) — form "Tambah
      Mitra Baru" (nama, id opsional, base/addon seat, tahun, catatan),
      tabel mitra terdaftar + tombol Reissue/Revoke, hasil (token +
      path folder + tombol salin) langsung tampil setelah submit.
- [x] Link sidebar "🤝 Kelola Mitra" **SENGAJA GAK di-hardcode** di HTML
      halaman admin manapun — disuntik dinamis lewat `public/js/api.js`
      (`injectMitraLinkIfMaster()`), CUMA muncul kalau `GET /api/config`
      balikin `vendorMasterMode:true`. Instalasi customer gak akan
      pernah lihat link ke halaman yang emang gak ada di paket mereka.
- [x] **2 lapis proteksi biar fitur ini TIDAK PERNAH ke-ship ke
      customer** (independen satu sama lain, kalau salah satu kelupaan
      yang lain tetap nutup):
      1. Runtime: `VENDOR_MASTER_MODE` cuma boleh `true` di `.env`
         vendor sendiri.
      2. **Build-time** (`scripts/build-obfuscate.js`, `EXCLUDE_PATHS`)
         — `routes/mitra.route.js` & `public/admin/mitra.html` DIHAPUS
         TOTAL dari proses build, apapun env-nya. **Dites**: build
         customer (`npm run build`) dicek `dist/routes/` &
         `dist/public/admin/` TIDAK PERNAH punya file mitra sama
         sekali; jalanin `dist/server.js` dengan
         `VENDOR_MASTER_MODE=true` SENGAJA (simulasi salah konfigurasi)
         → log peringatan `[MITRA] ... gak ketemu (normal kalau ini
         instalasi CUSTOMER)`, app TETAP jalan normal, gak crash, gak
         ada endpoint mitra yang kebuka.
- [x] Folder `docker/` (baru, root project) — tempat SEMUA paket
      per-mitra ke-generate (`docker/<id_mitra>/`), di-gitignore total
      (isinya `JWT_SECRET` & token per-customer, rahasia) KECUALI
      `.gitkeep` biar strukturnya kebawa di clone baru.
- [x] `Caddyfile.example` (baru) — reverse proxy siap pakai buat HTTPS
      otomatis (Let's Encrypt via Caddy, gak perlu setup manual
      certbot/openssl), ikut di-copy ke tiap paket mitra yang
      di-scaffold. Menjawab concern "URL harus terenkripsi" — HTTPS
      itu urusan REVERSE PROXY di depan app, bukan sesuatu yang app
      Node.js sendiri yang atur.
- [x] **Dites end-to-end** (lihat log testing): create mitra → folder +
      `.env` + token + `docker-compose.yml` (tag image ikut versi
      `VERSION` file) semua benar; reissue → `JWT_SECRET` KONSISTEN
      sebelum/sesudah (setelah fix bug di atas); reissue ke id yang
      udah di-revoke → ditolak dengan pesan jelas; create dengan id
      yang udah dipakai → 409 ditolak; revoke lalu list → status
      NONAKTIF kebaca benar di tabel.

#### H. Hardening tambahan ("aman dari hacker2") — SELESAI, sudah dites
- **Kerangka berpikir yang dipegang** (biar gak oversell): ancaman
  paling realistis di sini BUKAN nation-state attacker, tapi (a) bot
  brute-force login umum, (b) orang iseng buka DevTools & baca kode
  polos, (c) situs lain nyoba fetch API ini pakai token yang somehow
  ke-leak. Semua item di bawah ngincer 3 ancaman KONKRET itu — bukan
  klaim "gak bisa diretas", yang mana gak ada software yang bisa
  klaim itu jujur (lihat bagian 9).
- [x] **Obfuscation client-side** (`scripts/build-obfuscate.js` ditulis
      ulang) — SEBELUMNYA cuma server-side (`routes/helpers/middleware`)
      yang diobfuscate, `public/` disalin POLOS (alasan lama: "browser
      toh selalu bisa view-source"). Itu tetap benar, TAPI beda antara
      "bisa dibaca kalau niat" vs "kebaca sekali klik Inspect Element"
      — sekarang `public/js/*.js` DIOBFUSCATE (preset lebih ringan,
      tanpa controlFlowFlattening/selfDefending yang berat buat kode
      yang di-load ulang tiap halaman) DAN semua inline `<script>` di
      tiap halaman HTML admin JUGA diobfuscate di tempat (regex extract
      → obfuscate → reinsert, `<script src=...>` gak disentuh, cuma
      isinya file eksternal yang dirujuk yang diobfuscate terpisah).
      **Dites**: build customer, semua file JS hasil obfuscate lolos
      `node --check`, semua inline script di 9 halaman HTML lolos
      parse ulang (`vm.Script`), server jalan normal dari hasil build
      itu, halaman ke-serve 200, `grep` string asli kayak `"Api.init"`
      di HTML hasil build gak ketemu lagi (buktinya beneran teracak).
- [x] `helmet()` (dependency baru) dipasang di `server.js` — header
      keamanan standar (`X-Content-Type-Options`, `X-Frame-Options`,
      ilangin `X-Powered-By`, dst). `contentSecurityPolicy` SENGAJA
      DIMATIKAN — app ini masih pakai banyak inline `<script>` + load
      MapLibre GL & Socket.IO client dari CDN (unpkg/cdn.socket.io) di
      hampir semua halaman admin, CSP default bakal nge-block semua
      itu & bikin dashboard blank. Ngerapihin ke CSP proper (nonce per
      inline script, self-host semua library eksternal) itu kerjaan
      TERPISAH yang lebih besar, dicatat sebagai utang, bukan
      dikerjain setengah-setengah yang malah bikin app rusak.
- [x] `app.set('trust proxy', 1)` — tanpa ini, `req.ip` SELALU keliatan
      alamat reverse proxy (127.0.0.1) buat SEMUA request kalau app-nya
      ada di belakang nginx/Caddy, bikin rate-limit per-IP di bawah ini
      gak berguna sama sekali (semua orang keitung "1 IP" yang sama).
- [x] **Rate-limit login** (`routes/auth.route.js`, in-memory `Map`,
      pola yang sama kayak rate-limit di `routes/license.route.js`) —
      max 8 percobaan gagal / 15 menit, key-nya IP+username (bukan IP
      doang, biar 1 kantor yang sama-sama pakai 1 IP publik gak saling
      ngeblokir). Reset otomatis begitu login SUKSES.
- [x] CORS DIPERKETAT — `cors()` polos (izinin origin APAPUN) diganti
      jadi OFF BY DEFAULT, cuma nyala kalau env `ALLOWED_ORIGINS` diisi
      eksplisit. App ini single-origin (frontend & API di server yang
      sama), jadi gak butuh CORS buat pemakaian normal — yang tadinya
      kebuka itu attack surface yang gak perlu.
- [x] **Klarifikasi jujur soal "URL terenkripsi"** (biar gak salah
      ekspektasi): HTTPS (lewat `Caddyfile.example` di atas) enkripsi
      data SELAMA PERJALANAN jaringan -- itu YANG BISA dikasih. HTTPS
      **TIDAK** nyembunyiin apapun dari orang yang buka DevTools di
      browser MEREKA SENDIRI (itu cara kerja browser di SEMUA situs,
      termasuk bank -- bukan celah aplikasi ini). Yang beneran ngincer
      "kode kebaca di Inspect Element" itu item obfuscation di atas,
      bukan HTTPS. Dua hal ini SERING KETUKAR di ekspektasi non-teknis,
      makanya dicatat eksplisit di sini.

#### I. Instalasi master TIDAK PERNAH ke-lock + DB/tabel per-mitra + upgrade aman (instruksi baru, dicatat verbatim di bagian 13) — SELESAI, sudah dites
- [x] **`middleware/license.js` — gerbang lisensi DILEWATIN TOTAL
      kalau `VENDOR_MASTER_MODE=true`** (satu baris di awal fungsi
      `requireValidLicense`). Instalasi master (port 3010 ini) BUKAN
      instalasi customer -- dia yang justru NERBITIN lisensi buat
      customer lain, jadi gak masuk akal kalau dia sendiri bisa
      ke-lock gara-gara lisensi contoh di dev-nya expired. Menu/halaman
      🔑 Lisensi TETAP ada & tetap bisa dibuka normal (endpoint-nya
      emang selalu di luar gerbang), yang berubah CUMA gerbangnya gak
      pernah nge-block apa pun. **Dites**: `license.lic` DIHAPUS
      SENGAJA (simulasi paling ekstrem) → endpoint bisnis (`/api/teknisi`
      dst) TETAP balikin 200 selama `VENDOR_MASTER_MODE=true`, sementara
      `GET /api/license/status` TETAP jujur ngelaporin `NO_LICENSE`
      (gak dipalsuin, cuma gerbangnya yang dilewatin).
- [x] **Nama database & prefix tabel ikut nama mitra** (misal mitra
      "Djalu Depok" → `id_mitra: djalu_depok` → `DB_NAME=mitra_djalu_depok`,
      tabel `djalu_depok_admins`/`djalu_depok_teknisi`/dst). Implementasi
      DIPILIH SECARA SADAR **BUKAN** dengan refactor manual ~100 query
      SQL di 13 file (`routes/*.js`, `helpers/*.js`, dst yang masih
      nulis literal `pt_kapuk_xxx`) -- itu beresiko tinggi (gampang ada
      satu query ke-lewat, bug diem-diem yang baru ketauan pas customer
      lapor). Sebagai gantinya:
      - `db.js` DIBUNGKUS Proxy yang nyegat `pool.query()` DAN
        `pool.getConnection()` (dipakai transaksi di
        `teknisi.route.js`/`tiket.route.js`) -- SATU TITIK PALING
        BAWAH sebelum query beneran dikirim ke MySQL, literal
        `pt_kapuk_` di teks query di-substitusi ke `TABLE_PREFIX` env
        (default TETAP `pt_kapuk_`, fast-path tanpa regex kalau gak
        diubah -- 100% backward compatible & tanpa overhead buat
        instalasi lama). **SELURUH kode route/helper TIDAK DIUBAH SAMA
        SEKALI** -- tetap nulis `pt_kapuk_admins` dst apa adanya.
      - `helpers/schema-template.js` (baru) -- `renderSchema()` buat
        substitusi nama DB & prefix tabel di teks `schema.sql`, dipakai
        BARENGAN oleh `scripts/migrate.js` (jalan di instalasi
        customer) DAN `licensing-tools/lib/issue-license.js`
        (vendor-only, scaffold folder) -- satu sumber kebenaran, gak
        dobel regex di 2 tempat.
      - `scripts/migrate.js` diupdate: cek tabel admin pakai nama yang
        UDAH DI-PREFIX (`${TABLE_PREFIX}admins`, bukan hardcode
        `pt_kapuk_admins`) sebelum mutusin skip/jalan.
      - `licensing-tools/lib/issue-license.js` (`scaffoldDockerPackage`)
        generate `.env` mitra baru dengan `DB_NAME=mitra_<id>` &
        `TABLE_PREFIX=<id>_` otomatis, DAN pre-render `schema.sql` yang
        di-copy ke folder paket biar isinya udah kebaca nama asli
        (bukan template `pt_kapuk_`/`pt_gokak_indonesia` mentah).
      - **Dites end-to-end BENERAN** (bukan cuma unit test): generate
        mitra "Djalu Depok" lewat menu Kelola Mitra → `.env` & `schema.sql`
        hasil generate benar (`mitra_djalu_depok` / `djalu_depok_*`) →
        `scripts/migrate.js` dijalanin BENERAN pakai env itu → 11 tabel
        `djalu_depok_*` kebentuk di database `mitra_djalu_depok` yang
        BENERAN ada di MySQL → app di-boot pakai config itu → LOGIN
        SUKSES lewat tabel `djalu_depok_admins` → `GET /api/teknisi`
        (query JOIN 2 tabel: `djalu_depok_teknisi` + `djalu_depok_area`)
        balikin data BENERAN dengan sukses. Semua artefak test (database,
        folder, registry) dibersihkan setelahnya.
- [x] **Upgrade versi aplikasi TANPA nyentuh data/lisensi mitra yang
      udah jalan**: tombol baru **🔁 Refresh Paket** (beda dari
      **🔄 Reissue**) -- `refreshPackage()` di `lib/issue-license.js`
      regenerate `docker-compose.yml` (tag image ikut `VERSION`
      TERBARU) + `schema.sql` + `README.md` PAKAI TOKEN YANG SUDAH ADA
      (`last_token`/`last_token_meta`, disimpan di registry tiap kali
      `generateLicenseToken()` jalan) -- **TIDAK nerbitin lisensi baru
      sama sekali**, `JWT_SECRET` di `.env` folder itu TETAP
      dipertahankan (baca punya lama dulu via `readExistingJwtSecret()`
      sebelum mutusin generate yang baru). Data mitra AMAN karena
      alasan yang SUDAH ADA dari awal (bukan baru): database di luar
      container (`docker-compose.yml` gak pernah nyentuh volume data
      MySQL), lisensi di named volume `license_data` yang persisten
      lintas `docker compose up -d` ulang. **Dites**: bump `VERSION`
      jadi `1.1.0` → panggil refresh-package → `docker-compose.yml`
      tag ke-update ke `1.1.0`, `JWT_SECRET` & isi `LICENSE-TOKEN.txt`
      TERBUKTI TIDAK BERUBAH (dibandingkan sebelum & sesudah).

---

## 11. Instruksi yang menggerakkan Fase 2 (dicatat verbatim + terjemahan, biar gak hilang konteksnya)

Instruksi asli dari pemilik project:

> "ya, elesaikan dlu semua fase menurut mu, saya mau codingan / projek
> ada di server user itu ke enkrip aman, ga bisa utak atik license.
> meskipun nanti user menggunakan ai untuk memecahkan code. dan ada
> code khusus untuk bug fixing atau add fitur nantinya (atur dah
> gimana enaknya) pokoknya saya share code, install di server mereka,
> user akses dashboard, masukan token yg di beri vendor, lalu jika
> valid web bisa kebuka. dan ada halaman/ menu license untuk lihat
> detail license yg aktif atau yg nantinya ada request license yg baru
> misal mau nambah 5 user di tangah jalan pokoknya walaupun instal di
> server user codingan aman, license aman, port gak bisa di rubah2
> kalaupun kerubah, tetep aman sesuai license, jam/waktu juga gak bisa
> dimanipulasi"

Poin per poin, dan di mana itu ditangani:

- **"selesaikan semua fase"** → seluruh Fase 2 (bagian A-E di atas)
  dikerjain di sesi ini, pakai asumsi kerja on-prem (belum final
  dikonfirmasi, lihat bagian 10-A).
- **"codingan ke enkrip aman, ga bisa utak atik license, meskipun pakai
  AI"** → sudah dijawab jujur di awal & dicatat di bagian 9: TIDAK ADA
  proteksi software yang 100% tahan terhadap penyerang dengan akses
  root ke mesinnya sendiri, AI atau bukan — ini hukum keamanan
  fundamental, bukan keterbatasan pengerjaan. Yang dibangun adalah
  **lapisan berlapis** (obfuscation, Docker, JWT RS256, deteksi jam
  mundur lokal + online) yang menaikkan kesulitan/biaya bypass
  setinggi mungkin secara praktis, plus penekanan bahwa backstop
  terakhir yang benar-benar "tahan AI" adalah kontrak/legal (bagian 4).
- **"code khusus buat bug fixing/nambah fitur nanti"** → karena
  distribusinya lewat Docker image (bukan `git clone` ke server
  customer), update/bugfix cukup lewat **image baru** (`docker build` +
  `docker compose up -d` ulang di server customer) — source code TETAP
  gak pernah diserahkan mentah, sama modelnya kayak SaaS vendor lain
  ngirim update. `VERSION` file dibuat buat nge-track versi mana yang
  jalan di server customer (kebaca lewat `GET /api/license/status`).
- **"share code, install di server mereka, akses dashboard, masukan
  token vendor, kalau valid web kebuka"** → ini persis flow Fase 1 yang
  udah ada (`license.lic` / `LICENSE_KEY` → `helpers/license.js` →
  `middleware/license.js` → gerbang `/api`), gak berubah, cuma sekarang
  dibungkus Docker buat pengirimannya.
- **"halaman/menu license, lihat detail aktif, request nambah user di
  tengah jalan"** → bagian 10-E: `public/admin/license.html` + endpoint
  `POST /api/license/request` / `GET /api/license/requests`.
- **"port gak bisa dirubah buat bypass"** → sudah benar dari
  arsitekturnya sendiri: middleware lisensi (`middleware/license.js`)
  gak pernah baca `process.env.PORT` sama sekali, jadi gak ada mekanisme
  apapun yang menghubungkan nilai PORT ke status lisensi. Dibuktikan
  lewat testing berulang di banyak port acak (3090-an s/d 3199),
  hasilnya identik. Dicatat eksplisit di bagian 7.
- **"jam/waktu gak bisa dimanipulasi"** → bagian 9, 2 lapis: deteksi
  lokal (`checkClockIntegrity`, selalu aktif) + phone-home online
  (`helpers/phone-home.js` + `vendor-license-service/`, opsional,
  butuh hosting vendor yang belum ada). Batasan jujurnya: kalau CUMA
  pakai lapis lokal (situasi saat ini, karena vendor-license-service
  belum di-hosting), org yang tau caranya (akses DB + reset baris
  anchor barengan mundurin jam) masih bisa lolos — makanya phone-home
  dibangun sebagai penutup celah itu begitu ada infra hosting.

---

## 12. Instruksi yang menggerakkan bagian 10-G/H (menu Kelola Mitra + hardening tambahan)

Instruksi asli:

> "anggep lah sekarang di por 3010 ini sebagai masternya. dan akan
> banyak mitra yg pakai
>
> buatkan folder per mitra misal docker/pt_gokak untuk tampung list
> docker(sampe ke schema.sql sesuai mitranya nanti) yg akan di share.
> jadi nanti pas saya buka projek ini 3010 ada halaman untuk
> tambah mitra baru -> langsung auto buat docker composenya di folder
> dan perintilannya, beserta token license yg telah di set dan tinggal
> share jika mitra sudah install)
>
> rapihkkan lagi struktur code/file  biar ga berantakan.
> trus juga pastikan codenya aman dari hacker2, url ter enkripsi, di
> inspect element aman codenya js semua ke enkrip.
> soalnya saya di remehin sama tim infra bikin aplikasi pake ai di
> olok2"

Poin per poin, dan di mana itu ditangani:

- **"port 3010 ini sebagai masternya"** → `VENDOR_MASTER_MODE=true` di
  `.env` lokal (bagian 10-G) — instalasi INI (dijalanin dari source,
  bukan Docker) jadi konsol kelola mitra vendor.
- **"folder per mitra ... docker/pt_gokak ... sampe ke schema.sql"** →
  `docker/<id_mitra>/` (bagian 10-G), otomatis isi `docker-compose.yml`
  + `.env` + `schema.sql` + `LICENSE-TOKEN.txt` + `README.md` +
  `Caddyfile.example`.
- **"ada halaman tambah mitra baru -> langsung auto buat docker
  composenya ... beserta token license"** → `public/admin/mitra.html` +
  `routes/mitra.route.js` + `licensing-tools/lib/issue-license.js`
  (bagian 10-G) — 1 form submit, langsung jadi semua.
- **"tinggal share jika mitra sudah install"** → folder yang
  di-scaffold itu SIAP di-zip apa adanya (cuma perlu isi kredensial DB
  & koordinat pabrik sebelum `docker compose up`), lihat
  `INSTALL-CUSTOMER.md` bagian 1.2 yang sudah diupdate.
- **"rapihkan struktur code/file"** → `licensing-tools/lib/issue-
  license.js` jadi SATU sumber kebenaran buat logic penerbitan lisensi
  (sebelumnya dobel di 2 CLI script terpisah, lihat bagian 10-G).
- **"aman dari hacker2"** → `helmet()`, rate-limit login, CORS
  diperketat, `trust proxy` (bagian 10-H) — ngincer ancaman KONKRET
  (brute-force, cross-origin abuse), bukan klaim kosong "gak bisa
  diretas".
- **"url ter enkripsi"** → `Caddyfile.example` (HTTPS otomatis via
  Caddy) — DITAMBAH klarifikasi jujur (bagian 10-H) bahwa HTTPS
  ngelindungin data DI JARINGAN, bukan nyembunyiin apapun dari DevTools
  browser sendiri (itu bukan celah, itu cara kerja browser di semua
  situs).
- **"di inspect element aman codenya js semua ke enkrip"** →
  `scripts/build-obfuscate.js` sekarang JUGA obfuscate `public/js/*.js`
  + inline `<script>` di semua halaman HTML (sebelumnya cuma
  server-side), bagian 10-H. **Batasan jujur yang tetap berlaku**:
  ini "obfuscate" (susah dibaca), BUKAN "enkripsi" beneran — browser
  tetap harus bisa EKSEKUSI kodenya, jadi secara prinsip tetap bisa
  di-deobfuscate sama orang/tool yang niat & sabar (termasuk dibantu
  AI) — cuma jauh lebih makan waktu & biaya dibanding baca kode polos.
  Ini MENAIKKAN standar dibanding sebelumnya (yang sebelumnya emang
  gak ada usaha sama sekali di sisi client), bukan bikin "gak bisa
  dibaca sama sekali" — jangan disampaikan ke tim infra sebagai klaim
  yang lebih besar dari itu, biar gak jadi bumerang kalau ada yang
  coba buktikan sebaliknya.

---

## 13. Instruksi yang menggerakkan bagian 10-I (master gak pernah expired + DB/tabel per mitra + upgrade aman)

Instruksi asli:

> "intinya 3010 local saya ini sebagai master tidak akan ada expired,
> dan proses development selalu ada di sini.(selalu bisa di buka,
> meskipun ada halaman license disini)
>
> nama db dan tabel itu sesuaikan dengan nama mitra
>
> misal nama mitra djalu depok
>
> berarti schema yg ke generate
> db_name : mitra_djalu_depok
> tbl_name : djalu_depok_
>
> dan jika ada pengembangan fitur dilocal saya misalkan v.2 ya
> langsung ke generate lagi dockernya nanti tinggal update aja di
> server mitra docker terbarunya. dan jangan sampai data mereka yg
> sudah berjalan itu terhapus (termasuk license yg sudah berjalannya
> juga mengikuti).
>
> paham kan maksud saya?"

Poin per poin, dan di mana itu ditangani:

- **"3010 local ... tidak akan ada expired ... selalu bisa dibuka,
  meskipun ada halaman license disini"** → `VENDOR_MASTER_MODE=true`
  bikin gerbang lisensi (`middleware/license.js`) dilewatin total,
  TAPI halaman/menu Lisensi tetap ada & tetap jujur nunjukin status
  aslinya (bagian 10-I) -- persis "selalu bisa dibuka" + "halaman
  license tetap ada" sekaligus.
- **"nama db dan tabel sesuaikan nama mitra ... db_name:
  mitra_djalu_depok, tbl_name: djalu_depok_"** → persis formatnya
  diikuti di `scaffoldDockerPackage()` (bagian 10-I): `DB_NAME=mitra_<id_mitra>`,
  `TABLE_PREFIX=<id_mitra>_`. Sudah dites BENERAN pakai contoh "Djalu
  Depok" yang sama persis dari instruksi ini.
- **"kalau ada pengembangan fitur v2, langsung generate lagi dockernya,
  tinggal update di server mitra"** → tombol 🔁 Refresh Paket (bagian
  10-I) -- regenerate `docker-compose.yml` ikut versi terbaru, cukup
  kirim file itu ke mitra & `docker compose up -d` ulang di server
  mereka.
- **"jangan sampai data mereka yang sudah berjalan itu terhapus"** →
  SUDAH terjamin dari desain sebelumnya (`scripts/migrate.js` skip
  kalau tabel admin udah ada, database MySQL di luar container sama
  sekali) -- gak ada yang berubah soal ini, cuma diverifikasi ulang
  lewat testing eksplisit di bagian 10-I.
- **"termasuk license yang sudah berjalan juga mengikuti"** →
  `refreshPackage()` SENGAJA gak pernah manggil `generateLicenseToken()`
  -- token & `JWT_SECRET` lama di-reuse apa adanya, dibuktikan lewat
  perbandingan sebelum/sesudah refresh di testing (bagian 10-I).
