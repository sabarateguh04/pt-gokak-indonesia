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
- [ ] Build & publish image Docker (lihat bagian 1.4).

### 1.2 Daftarkan customer sebagai "mitra" (SEKALI per customer, bukan per-renewal)
Ini yang bikin token lisensi customer ini gak bisa asal ditempel ke
instalasi customer LAIN (lihat "id_mitra" di `notesubscribe.md`).

```bash
node licensing-tools/register-partner.js --id PT-GOKAK --name "PT Gokak Indonesia" --note "Kontrak awal 50 seat/tahun, mulai 2026-08"
```

`--id` itu KODE PENDEK bebas kamu tentukan (huruf/angka/strip, gak ada
spasi) — ini yang nanti WAJIB sama persis dengan `ID_MITRA` di `.env`
customer itu. Cek semua yang udah terdaftar kapan aja:
```bash
node licensing-tools/register-partner.js --list
```

### 1.3 Siapkan paket buat customer INI (per-customer, beda tiap instalasi)
Folder yang dikirim/dibawa ke lokasi instalasi isinya:

```
paket-instalasi-pt-gokak/
├── docker-compose.yml      (salin apa adanya dari repo)
└── .env                    (BUKAN .env.example — isi manual per poin di bawah)
```

Isi `.env` (salin dari `.env.example`, lalu isi/ubah baris-baris ini):
```
PORT=3010
DB_HOST=host.docker.internal      # atau IP/host MySQL customer
DB_USER=...                        # kredensial DB customer
DB_PASSWORD=...
DB_NAME=pt_gokak_indonesia
DB_PORT=3306
JWT_SECRET=<generate random panjang, JANGAN dipakai ulang antar customer>
FACTORY_LAT=...                    # koordinat pabrik customer
FACTORY_LNG=...
ID_MITRA=PT-GOKAK                  # HARUS SAMA PERSIS dengan --id di langkah 1.2
VENDOR_SUPPORT_EMAIL=support@kita.co.id
```
`JWT_SECRET` generate gampang: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`

**Lisensi (`license.lic`) TIDAK ikut di paket ini** — itu ditempel
BELAKANGAN lewat dashboard (lihat bagian 2, langkah 5). Kalau kontrak
sudah pasti dari awal, boleh langsung generate tokennya sekarang juga
(bagian 1.5) supaya siap ditempel begitu dashboard-nya kebuka pertama
kali — tapi gak wajib disiapkan duluan.

### 1.4 Build image Docker (butuh Docker terpasang di mesin yang build)
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

### 1.5 Generate token lisensi pertama
```bash
node licensing-tools/generate-license.js --id PT-GOKAK --customer "PT Gokak Indonesia" --base 50 --addon 0 --years 1
```
Simpan token yang keluar (baris panjang setelah "License key berhasil
dibuat") — itu yang ditempel admin customer di dashboard (bagian 2,
langkah 5). **Private key TIDAK IKUT ke mana-mana, tetap di laptop kita.**

---

## 🖥️ BAGIAN 2 — Instalasi di server/PC tujuan

Butuh: **Docker Desktop** (Windows/Mac) atau **Docker Engine + Docker
Compose plugin** (Linux) sudah terpasang & jalan. Cek dengan:
```bash
docker --version
docker compose version
```

### Langkah 1 — Siapkan folder & file
Taruh `docker-compose.yml` + `.env` (dari vendor, bagian 1.3) dalam satu
folder, misal `C:\pt-gokak-app\` atau `/opt/pt-gokak-app/`.

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
tempel token dari vendor (bagian 1.5) di kotak "Pasang Token Lisensi
Baru", klik **Aktifkan**. Semua fitur langsung terbuka, TANPA restart
container.

### Langkah 6 — Selesai, verifikasi
- Cek `http://localhost:3010/health` → harus `{"status":"ok"}`.
- Cek menu Lisensi → status **AKTIF**, seat & tanggal berlaku sesuai
  kontrak.
- Coba buka menu lain (Teknisi, Tiket, dst) → harus bisa diakses normal.

---

## Update aplikasi ke versi baru (bugfix/fitur, bukan install pertama)

1. Vendor kirim image baru (tag versi baru, misal `1.1.0`) — lewat
   `docker load` file `.tar` baru, atau `docker pull` kalau pakai
   registry.
2. Update `image:` di `docker-compose.yml` ke tag barunya.
3. `docker compose up -d` lagi — container lama diganti yang baru,
   **data database & lisensi TIDAK HILANG** (database di luar container,
   lisensi di named volume `license_data` yang persisten).

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
