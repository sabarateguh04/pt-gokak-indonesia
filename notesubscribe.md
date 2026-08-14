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
│       ▼                      │         │  pt-gokak-indonesia (app)    │
│  generate-license.js         │  kirim  │    ├─ config/license-        │
│  (tool internal, sign JWT) ──┼─license─┼──►│     public.pem (AMAN     │
│                               │  key    │     di-ship, cuma verify)    │
│  (Fase 2, opsional)          │◄────────┼──  │  .env: LICENSE_KEY=...  │
│  License API (phone-home     │  cek    │    │  helpers/license.js     │
│  verification berkala)       │  berkala│    │  middleware/license.js  │
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
  "customer": "PT Gokak Indonesia",
  "base_seats": 50,
  "addon_seats": 0,
  "iat": 1755129600,
  "exp": 1786665600
}
```

- `exp` = klaim bawaan JWT, otomatis divalidasi sama `jsonwebtoken.verify()`
  (lempar `TokenExpiredError` kalau udah lewat) — gak perlu logic manual.
- `total_seats = base_seats + addon_seats`, dihitung pas verifikasi,
  bukan disimpan terpisah (biar gak ada 2 sumber kebenaran).
- **Nambah add-on** = generate ULANG token (isi `addon_seats` baru,
  `exp` bisa dipertahanin sama), kirim token baru ke customer, mereka
  tinggal ganti `LICENSE_KEY` di `.env` + restart. Gak perlu ubah kode.
- **Perpanjang masa aktif** = generate ulang token juga, isi cuma `exp`
  yang beda.

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
4. Bantu instalasi awal (remote/onsite): jalanin `schema.sql`, isi
   `.env` (termasuk `LICENSE_KEY`), testing login & fitur inti.
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
4. Customer ganti `LICENSE_KEY` di `.env` mereka + restart service
   (atau tinggal tunggu, tergantung `LICENSE_CACHE_TTL_MS` di app —
   lihat bagian implementasi, defaultnya app re-verifikasi tiap
   beberapa jam sekali otomatis, jadi gak WAJIB restart instan).

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

- [ ] Paket aplikasi versi production (Fase 1: masih source biasa;
      Fase 2: compiled/obfuscated/Docker image — lihat bagian 10).
- [ ] `LICENSE_KEY` (string token, hasil dari `generate-license.js`).
- [ ] Dokumentasi instalasi (`.env` apa aja yang wajib diisi, cara
      jalanin `schema.sql`, cara start service) — **terpisah dari
      README dev**, gak perlu expose detail arsitektur internal.
- [ ] Kredensial admin awal (1x pakai, minta ganti password pas login
      pertama).
- [ ] Kontak support buat renewal/add-on/laporan bug.
- [ ] (Kalau ada) dokumen kontrak/BAST yang udah ditandatangani.

## 7. Yang perlu DISETUP CUSTOMER di server mereka

- [ ] Server dengan Node.js runtime (Fase 1) ATAU Docker Engine
      (Fase 2, kalau distribusi jadi image).
- [ ] MySQL/MariaDB server sendiri (data mereka, mereka yang backup).
- [ ] Isi `.env`: kredensial DB mereka, `JWT_SECRET`, koordinat
      pabrik (`FACTORY_LAT`/`FACTORY_LNG`), dan `LICENSE_KEY` dari kita.
- [ ] Jalanin `schema.sql` sekali di awal.
- [ ] Reverse proxy + SSL (nginx/caddy) kalau mau diakses via domain
      sendiri dari luar server — di luar tanggung jawab kita kecuali
      diminta bantu setup.
- [ ] Backup rutin database mereka sendiri (di luar scope aplikasi ini).
- [ ] *(Fase 2, kalau desainnya online phone-home)* akses jaringan
      OUTBOUND ke License Service kita (minimal port 443 keluar).

## 8. Yang perlu KITA (vendor) setup

- [ ] Generate RSA keypair (`license-private.pem` / `license-public.pem`)
      — **private key gak boleh pernah ikut ke-commit atau ke-ship**.
- [ ] Simpan private key di tempat aman (bukan di laptop biasa doang,
      idealnya password manager/secret store).
- [ ] Catatan customer & lisensi (spreadsheet dulu cukup buat awal):
      nama customer, seat, tanggal mulai/berakhir, riwayat perpanjangan.
- [ ] Proses/SOP internal: siapa yang boleh generate license key,
      gimana cara follow-up H-30 sebelum expired.
- [ ] *(Fase 2)* pipeline build buat compile/obfuscate app sebelum
      dikirim ke customer — jangan pernah `git clone` mentah ke server
      mereka.
- [ ] *(Fase 2, opsional)* License Service kecil (API) di server kita
      sendiri buat verifikasi online berkala — nutupin celah "customer
      majuin/mundurin jam server" di bagian 9.

---

## 9. Batasan & resiko yang perlu disadari (jangan di-oversell ke atasan)

- **Verifikasi Fase 1 itu OFFLINE** (baca token lokal aja, gak nelepon
  server kita). Konsekuensinya: kalau customer **mundurin jam sistem
  server mereka**, `exp` JWT bisa keliatan "belum expired" padahal
  udah lewat. Ini celah yang nyata. Mitigasinya ada di Fase 2 (online
  check berkala ke License Service kita, yang jamnya gak bisa mereka
  utak-atik).
- **Gak ada proteksi source code yang 100% gak bisa dibongkar** kalau
  aplikasinya jalan di server yang mereka kontrol penuh (root access).
  Semua teknik di Fase 2 (obfuscate, compile binary, Docker) itu
  **menaikkan tingkat kesulitan**, bukan bikin mustahil. Backstop yang
  sebenarnya adalah kontrak/legal (bagian 4, poin 5), bukan teknis.
- **Seat cuma dihitung dari teknisi aktif** (lihat bagian 3) — kalau
  bisnisnya ternyata mau hitung admin juga, gampang diubah tapi perlu
  dikonfirmasi dulu, jangan asumsi sepihak.
- **Kalau customer punya banyak server/lingkungan** (staging+production
  misalnya) dengan 1 license key yang sama, gak ada proteksi "1 license
  = 1 mesin" di Fase 1 (belum ada machine-fingerprint binding). Bisa
  ditambah di Fase 2 kalau perlu.

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

### Fase 2 — Hardening (belakangan, gak buru-buru)
- [ ] Keputusan final: SaaS vs on-prem (eskalasi ke atasan).
- [ ] Compile ke binary (Node SEA / `pkg`) atau minify+obfuscate.
- [ ] Distribusi via Docker image.
- [ ] License Service online (phone-home berkala, nutupin celah jam
      sistem di bagian 9).
- [ ] (Opsional) machine-fingerprint binding per license key.
