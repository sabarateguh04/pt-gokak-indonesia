# Panduan Instalasi — PT Gokak Indonesia (Tracking & Tiket System)

Dokumen ini buat 2 pembaca sekaligus, ditandai jelas per bagian:

- **🧑‍💼 VENDOR (kita)** — apa yang perlu disiapkan SEBELUM paket dikirim.
- **🖥️ INSTALLER** (bisa kita sendiri pas onsite, bisa IT customer, atau
  kamu sendiri pas simulasi di PC yang ada Docker-nya) — langkah nyalain
  aplikasinya di server/PC tujuan.

Model distribusinya: **Docker image**, BUKAN kirim source code mentah.
Kenapa & apa konsekuensinya, lihat `notesubscribe.md` bagian 9.

---

## 🧑‍💼 BAGIAN 1 — Yang VENDOR siapkan SEBELUM kirim ke customer

### 1.1 Sekali saja (infrastruktur vendor, bukan per-customer)
- [ ] RSA keypair sudah ada (`licensing-tools/keys/`) — kalau belum:
      `node licensing-tools/generate-keypair.js`
- [ ] Instalasi vendor sendiri jalan dengan `VENDOR_MASTER_MODE=true`
      di `.env` (lihat `.env.example`) — ini yang buka menu **🤝 Kelola
      Mitra** di dashboard, JANGAN PERNAH diisi `true` di paket manapun
      yang dikirim ke customer (lihat `notesubscribe.md` bagian 10-G).
- [ ] Build & publish image Docker (lihat bagian 1.3).

### 1.2 Daftarkan mitra baru + generate paket lengkap (per-customer)
**Cara termudah — lewat dashboard**: login ke instalasi master (yang
`VENDOR_MASTER_MODE=true`), buka menu **🤝 Kelola Mitra**, isi form
"Tambah Mitra Baru" (nama, base seat, add-on, masa aktif tahun). Sekali
submit, otomatis:
1. Terdaftar di registry lokal (`licensing-tools/partners.json`,
   gitignored) — ini yang bikin token gak bisa asal digenerate ulang
   buat id yang sama tanpa sepengetahuan vendor.
2. Token lisensi (JWT RS256) langsung jadi.
3. Folder **`docker/<id_mitra>/`** langsung ke-generate isinya
   `docker-compose.yml`, `.env` (JWT_SECRET random unik, `ID_MITRA` &
   `TABLE_PREFIX` udah keisi otomatis, `DB_NAME=mitra_<id_mitra>`),
   `schema.sql` (SUDAH direndernya pakai nama DB & prefix tabel mitra
   itu — misal mitra "Djalu Depok" → `id_mitra: djalu_depok` →
   `DB_NAME=mitra_djalu_depok`, tabel `djalu_depok_admins`,
   `djalu_depok_teknisi`, dst), `LICENSE-TOKEN.txt`, `README.md`,
   `Caddyfile.example` — **SIAP DI-ZIP & DIKIRIM APA ADANYA**, gak perlu
   ngedit manual apapun kecuali kredensial DB customer (`DB_HOST`/
   `DB_USER`/`DB_PASSWORD`) & koordinat pabrik (`FACTORY_LAT`/`LNG`).

Butuh perpanjang / nambah seat mitra yang SUDAH ada? Tombol **🔄
Reissue** di tabel daftar mitra — generate token baru, `JWT_SECRET`
instalasi LAMA tetap dipertahankan (sesi login customer gak ke-reset).
Mitra yang kontraknya berakhir tinggal klik **🚫 Revoke** (token lama
yang udah kepasang customer tetap jalan sampai `exp`, cuma nyegah
token BARU digenerate buat id itu).

**Alternatif lewat CLI** (kalau lebih suka scripting/otomatisasi,
manggil lib yang sama):
```bash
node licensing-tools/register-partner.js --id pt_gokak --name "PT Gokak Indonesia" --note "Kontrak awal 50 seat/tahun"
node licensing-tools/generate-license.js --id pt_gokak --customer "PT Gokak Indonesia" --base 50 --addon 0 --years 1
```
CLI ini CUMA generate token-nya (gak sekalian scaffold folder
`docker/`) — kalau butuh paket lengkap juga, tetap pakai dashboard.

### 1.3 Build image Docker (butuh Docker terpasang di mesin yang build)
```bash
docker build -t ptgokak/tracking-app:1.0.0 .
```
Kalau image-nya mau dipakai di mesin LAIN dari yang nge-build (server
customer beda mesin dari laptop kita), export & kirim filenya:
```bash
docker save ptgokak/tracking-app:1.0.0 -o ptgokak-tracking-app-1.0.0.tar
# di mesin tujuan:
docker load -i ptgokak-tracking-app-1.0.0.tar
```
Atau, kalau punya akun Docker Hub/registry privat, `docker push` lalu
`docker pull` di mesin tujuan — lebih rapi buat update rutin ke depannya.

---

## 🖥️ BAGIAN 2 — Instalasi di server/PC tujuan

Butuh: **Docker Desktop** (Windows/Mac) atau **Docker Engine + Docker
Compose plugin** (Linux) sudah terpasang & jalan. Cek dengan:
```bash
docker --version
docker compose version
```

### Langkah 1 — Siapkan folder & file
Ekstrak folder `docker/<id_mitra>/` yang dikirim vendor (bagian 1.2) ke
lokasi tujuan, misal `C:\pt-gokak-app\` atau `/opt/pt-gokak-app/` —
sudah isi `docker-compose.yml`, `.env`, `schema.sql`,
`LICENSE-TOKEN.txt`, `README.md`.

Kalau image dikirim sebagai file `.tar` (bukan dari registry):
```bash
docker load -i ptgokak-tracking-app-1.0.0.tar
```

### Langkah 2 — Pastikan MySQL sudah jalan & bisa diakses
MySQL/MariaDB **TIDAK ikut di dalam Docker** (sengaja, lihat komentar di
`docker-compose.yml`) — harus sudah ada duluan, kredensialnya sudah
sesuai isi `.env`. Kalau MySQL-nya jalan di mesin HOST yang sama
(bukan di container lain), pakai `DB_HOST=host.docker.internal` (sudah
di-setting otomatis lewat `extra_hosts` di `docker-compose.yml`, jalan
di Windows/Mac/Linux).

### Langkah 3 — Jalankan
```bash
docker compose up -d
```
Cek log-nya (skema database dibuat OTOMATIS di sini kalau masih kosong
— lihat `scripts/migrate.js`, TIDAK akan menghapus data kalau database
sudah pernah dipakai sebelumnya):
```bash
docker compose logs -f app
```
Tunggu sampai muncul baris `🚀 PT Gokak Indonesia — Tracking & Tiket
System jalan di http://localhost:3010`.

### Langkah 4 — Login pertama & ganti password
Buka `http://localhost:3010/admin/login` (ganti `localhost`/port kalau
diakses dari mesin lain / port kiri di `docker-compose.yml` diubah).

Akun default dari seed database:
```
username: admin
password: password123
```
**GANTI PASSWORD INI SEGERA** lewat menu profil/akun setelah login
pertama — ini akun contoh yang sama di semua instalasi baru, jangan
dibiarkan.

### Langkah 5 — Aktivasi lisensi
Login BERHASIL walaupun lisensi belum dipasang (memang didesain begitu
— lihat `notesubscribe.md` bagian 10-E), tapi menu selain 🔑 Lisensi
belum bisa diakses sampai lisensi valid. Buka menu **🔑 Lisensi**,
tempel isi `LICENSE-TOKEN.txt` (dari paket vendor) di kotak "Pasang
Token Lisensi Baru", klik **Aktifkan**. Semua fitur langsung terbuka,
TANPA restart container.

### Langkah 6 — Selesai, verifikasi
- Cek `http://localhost:3010/health` → harus `{"status":"ok"}`.
- Cek menu Lisensi → status **AKTIF**, seat & tanggal berlaku sesuai
  kontrak.
- Coba buka menu lain (Teknisi, Tiket, dst) → harus bisa diakses normal.

### Langkah 7 — (Direkomendasikan) Aktifkan HTTPS
Akses langsung `http://ip-server:3010` itu TIDAK terenkripsi — siapapun
yang bisa menyadap jaringan di antara browser & server ini bisa baca
isi trafiknya. Kalau server ini punya domain sendiri, pakai
`Caddyfile.example` yang ikut di paket (edit domainnya, jalankan Caddy)
— otomatis dapat sertifikat HTTPS gratis, gak perlu setup manual. Lihat
komentar di file itu buat detail & batasannya.

---

## Update aplikasi ke versi baru (bugfix/fitur, bukan install pertama)

1. Vendor bump `VERSION`, build image baru (tag ikut versi itu), lalu
   di menu **🤝 Kelola Mitra** klik **🔁 Refresh Paket** di baris mitra
   yang mau diupdate — ini regenerate `docker-compose.yml` (tag image
   ke versi terbaru) TANPA nyentuh lisensi/token/`JWT_SECRET` sama
   sekali (beda sama tombol Reissue, yang nerbitin lisensi BARU).
2. Kirim `docker-compose.yml` yang baru ke customer (atau file `.tar`
   image-nya kalau distribusinya lewat `docker load`, bukan registry).
3. Customer/installer: `docker load` (kalau perlu) → timpa
   `docker-compose.yml` lama dengan yang baru → `docker compose up -d`
   lagi — container lama diganti yang baru, **data database & lisensi
   TIDAK HILANG** (database di luar container sepenuhnya; lisensi di
   named volume `license_data`; `JWT_SECRET` yang sama di `.env` lama
   TETAP dipakai, sesi login yang aktif gak ikut ke-invalidate).

## Troubleshooting cepat

| Gejala | Kemungkinan penyebab |
|---|---|
| Container langsung mati / restart loop | Cek `docker compose logs app` — biasanya gagal konek DB (`DB_HOST`/kredensial salah, atau MySQL belum jalan). `scripts/migrate.js` retry otomatis ~30 detik sebelum nyerah. |
| Login gagal terus | Password salah/belum diganti dari `password123`, atau salah `username`. Reset lewat akses langsung ke MySQL kalau benar-benar lupa. |
| Semua menu selain Lisensi ke-block | Wajar kalau lisensi belum ditempel — lanjut ke Langkah 5. Pesan errornya nunjukin alasan spesifik (`NO_LICENSE`/`EXPIRED`/`ID_MITRA_MISMATCH`/dll). |
| "ID mitra tidak cocok" pas aktivasi | `ID_MITRA` di `.env` beda dengan `--id` yang dipakai vendor pas generate token. Cocokkan dulu (case-sensitive), atau minta vendor generate ulang dengan id yang benar. |
| Ganti port tapi lisensi ikut kebuka lock | Tidak akan terjadi — validasi lisensi tidak pernah membaca `PORT` sama sekali, aman diganti kapan saja. |

---

📄 Latar belakang keputusan desain (kenapa Docker, kenapa id_mitra, apa
batasannya) ada di `notesubscribe.md` — dokumen ini fokus ke LANGKAH
PRAKTIS instalasi saja.
