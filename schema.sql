-- ═══════════════════════════════════════════════════════════════════
-- PT GOKAK INDONESIA — EMPLOYEE TRACKING & TICKET SYSTEM
-- Schema database, prefix tabel: pt_kapuk_
--
-- Turunan dari be-oki-app, dipangkas jadi cuma 9 tabel (dari 15) --
-- gak ada lagi customer, site, perangkat, BA checklist, kebutuhan,
-- biaya, approval berjenjang. Liat README.md bagian 1 & 3 buat alasan
-- lengkapnya.
--
-- ⚠️  RESET TOTAL — DROP semua tabel pt_kapuk_* lalu bikin ulang dari
--     nol. SEMUA DATA HILANG. Backup dulu kalau perlu:
--       mysqldump -u root -p pt_gokak_indonesia > backup.sql
--
-- CARA JALANIN (sekali jalan utuh, jangan baris per baris manual):
--   mysql -u root -p < schema.sql
-- ═══════════════════════════════════════════════════════════════════

CREATE DATABASE IF NOT EXISTS pt_gokak_indonesia
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE pt_gokak_indonesia;

-- FK checks dimatikan dari sini sampai akhir file -- biar drop/create
-- gak perlu mikirin urutan manual.
SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS
  pt_kapuk_tiket_files,
  pt_kapuk_tiket_timeline,
  pt_kapuk_tiket_teknisi,
  pt_kapuk_tiket,
  pt_kapuk_teknisi_area,
  pt_kapuk_teknisi_lokasi,
  pt_kapuk_teknisi,
  pt_kapuk_area,
  pt_kapuk_admins;

-- ───────────────────────────────────────────────────────────
-- 1. ADMINS — akun yang login ke dashboard admin.
--    role disiapkan buat pembagian akses lebih halus nanti (misal
--    SUPERVISOR read-only) -- di versi ini semua ADMIN akses penuh.
-- ───────────────────────────────────────────────────────────
CREATE TABLE pt_kapuk_admins (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  username    VARCHAR(100) NOT NULL UNIQUE,
  password    VARCHAR(255) NOT NULL,
  nama        VARCHAR(150) NOT NULL,
  role        ENUM('ADMIN','SUPERVISOR') NOT NULL DEFAULT 'ADMIN',
  is_active   TINYINT(1) NOT NULL DEFAULT 1,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ───────────────────────────────────────────────────────────
-- 2. AREA — poligon 3D area pabrik yang digambar admin di halaman
--    Kelola Area. `is_primary` = area ini DIHITUNG sebagai "dalam
--    area pabrik" buat KPI kehadiran (union dari semua area primary);
--    area non-primary cuma buat referensi visual di peta (misal area
--    parkir), gak dihitung ke jam kerja.
--    `polygon` simpan ring GeoJSON: array [[lng,lat], ...] tertutup
--    (titik pertama & terakhir sama).
-- ───────────────────────────────────────────────────────────
CREATE TABLE pt_kapuk_area (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  nama        VARCHAR(150) NOT NULL,
  deskripsi   VARCHAR(255) NULL,
  is_primary  TINYINT(1) NOT NULL DEFAULT 1,
  height      INT NOT NULL DEFAULT 10,        -- tinggi extrusion 3D (meter)
  color       VARCHAR(9) NOT NULL DEFAULT '#f59e0b',
  polygon     JSON NOT NULL,
  is_active   TINYINT(1) NOT NULL DEFAULT 1,
  created_by  INT NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES pt_kapuk_admins(id),
  INDEX idx_area_primary (is_primary, is_active)
) ENGINE=InnoDB;

-- ───────────────────────────────────────────────────────────
-- 3. TEKNISI — akun & profil karyawan/teknisi pabrik.
--    status + latitude/longitude/last_location_at = sumber data buat
--    marker di peta dashboard admin (update tiap ping GPS).
-- ───────────────────────────────────────────────────────────
CREATE TABLE pt_kapuk_teknisi (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  username          VARCHAR(100) NOT NULL UNIQUE,
  password          VARCHAR(255) NOT NULL,
  nama              VARCHAR(150) NOT NULL,
  no_hp             VARCHAR(30)  NULL,
  email             VARCHAR(150) NULL,
  jabatan           VARCHAR(100) NULL,
  departemen        VARCHAR(100) NULL,
  foto_url          VARCHAR(500) NULL,
  status            ENUM('OFFLINE','ONLINE','ON_TASK') NOT NULL DEFAULT 'OFFLINE',
  latitude          DECIMAL(10,7) NULL,
  longitude         DECIMAL(10,7) NULL,
  last_location_at  DATETIME NULL,
  is_active         TINYINT(1) NOT NULL DEFAULT 1,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_teknisi_status (status)
) ENGINE=InnoDB;

-- ───────────────────────────────────────────────────────────
-- 4. RIWAYAT GPS TEKNISI — trail pergerakan, disimpan tiap ping
--    (bukan cuma titik terakhir kayak di tabel teknisi).
--    in_area/area_id = hasil cek point-in-polygon TERHADAP AREA
--    PRIMARY yang aktif SAAT ping ini masuk (disnapshot, bukan
--    dihitung ulang belakangan) -- ini yang jadi dasar perhitungan
--    KPI kehadiran "di dalam vs di luar area pabrik".
-- ───────────────────────────────────────────────────────────
CREATE TABLE pt_kapuk_teknisi_lokasi (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  teknisi_id    INT NOT NULL,
  tiket_id      INT NULL,
  latitude      DECIMAL(10,7) NOT NULL,
  longitude     DECIMAL(10,7) NOT NULL,
  in_area       TINYINT(1) NOT NULL DEFAULT 0,
  area_id       INT NULL,
  recorded_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (teknisi_id) REFERENCES pt_kapuk_teknisi(id) ON DELETE CASCADE,
  FOREIGN KEY (area_id) REFERENCES pt_kapuk_area(id) ON DELETE SET NULL,
  INDEX idx_teknisi_time (teknisi_id, recorded_at)
) ENGINE=InnoDB;

-- ───────────────────────────────────────────────────────────
-- 5. TEKNISI × AREA — area kerja yang di-assign admin ke teknisi dari
--    master area (bagian 2). 1 teknisi boleh terdaftar di beberapa
--    area. SIFATNYA ORGANISASI/INFORMASI ("teknisi ini seharusnya
--    kerja di area mana") -- BUKAN yang nentuin in_area/geofence di
--    pt_kapuk_teknisi_lokasi (itu tetep union semua area is_primary,
--    apapun teknisinya). Kalau nanti mau geofence per-teknisi ngikut
--    assignment ini, gampang -- tinggal filter areanya pas classifyPoint.
-- ───────────────────────────────────────────────────────────
CREATE TABLE pt_kapuk_teknisi_area (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  teknisi_id  INT NOT NULL,
  area_id     INT NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_teknisi_area (teknisi_id, area_id),
  FOREIGN KEY (teknisi_id) REFERENCES pt_kapuk_teknisi(id) ON DELETE CASCADE,
  FOREIGN KEY (area_id)    REFERENCES pt_kapuk_area(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ───────────────────────────────────────────────────────────
-- 6. TIKET — inti sistem (dulu "order"). Tanpa approval, tanpa
--    BA-checklist -- begitu admin assign, langsung ASSIGNED.
--    Bisa dibuat ADMIN *atau* TEKNISI sendiri (self-service) --
--    makanya created_by dipecah 2 kolom nullable (persis pola
--    uploaded_by_admin_id/uploaded_by_teknisi_id di tiket_files),
--    karena FK gak bisa nunjuk ke 2 tabel beda sekaligus.
--    area_id = lokasi kerja, WAJIB dari master pt_kapuk_area (dropdown,
--    bukan teks bebas lagi) -- tetap bisa diedit (oleh admin ATAU
--    teknisi yang di-assign) sampai tiket-nya DONE/CANCELLED.
--    tanggal_mulai/tanggal_selesai = rencana jadwal kerja (DATE),
--    beda sama selesai_at (DATETIME, waktu ACTUAL pas di-klik selesai).
-- ───────────────────────────────────────────────────────────
CREATE TABLE pt_kapuk_tiket (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  tiket_no              VARCHAR(20) NOT NULL UNIQUE,

  judul                 VARCHAR(200) NOT NULL,
  deskripsi             TEXT NULL,
  kategori              ENUM('MAINTENANCE','PERBAIKAN','INSPEKSI','LAINNYA') NOT NULL DEFAULT 'PERBAIKAN',
  priority              ENUM('LOW','MEDIUM','HIGH') NOT NULL DEFAULT 'MEDIUM',

  area_id               INT NULL,            -- lokasi kerja, dari master pt_kapuk_area
  tanggal_mulai         DATE NULL,
  tanggal_selesai       DATE NULL,
  latitude              DECIMAL(10,7) NULL,  -- titik pin tugas di peta (opsional, override dari area)
  longitude             DECIMAL(10,7) NULL,

  status                ENUM('NEW','ASSIGNED','IN_PROGRESS','DONE','CANCELLED') NOT NULL DEFAULT 'NEW',

  created_by_admin_id   INT NULL,
  created_by_teknisi_id INT NULL,
  created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  selesai_at            DATETIME NULL,

  FOREIGN KEY (area_id)               REFERENCES pt_kapuk_area(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by_admin_id)   REFERENCES pt_kapuk_admins(id),
  FOREIGN KEY (created_by_teknisi_id) REFERENCES pt_kapuk_teknisi(id),
  INDEX idx_tiket_status (status),
  INDEX idx_tiket_created (created_at)
) ENGINE=InnoDB;

-- ───────────────────────────────────────────────────────────
-- 7. TEKNISI PER TIKET — assign langsung (tanpa tawar/terima),
--    boleh lebih dari satu teknisi per tiket. assigned_by juga
--    dipecah 2 kolom nullable -- kalau teknisi bikin tiket sendiri,
--    "yang assign" ya dia sendiri, bukan admin.
-- ───────────────────────────────────────────────────────────
CREATE TABLE pt_kapuk_tiket_teknisi (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  tiket_id              INT NOT NULL,
  teknisi_id            INT NOT NULL,
  assigned_by_admin_id   INT NULL,
  assigned_by_teknisi_id INT NULL,
  assigned_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_tiket_teknisi (tiket_id, teknisi_id),
  FOREIGN KEY (tiket_id)               REFERENCES pt_kapuk_tiket(id) ON DELETE CASCADE,
  FOREIGN KEY (teknisi_id)             REFERENCES pt_kapuk_teknisi(id),
  FOREIGN KEY (assigned_by_admin_id)   REFERENCES pt_kapuk_admins(id),
  FOREIGN KEY (assigned_by_teknisi_id) REFERENCES pt_kapuk_teknisi(id)
) ENGINE=InnoDB;

-- ───────────────────────────────────────────────────────────
-- 8. TIMELINE — log aktivitas per tiket (buat riwayat & notifikasi).
-- ───────────────────────────────────────────────────────────
CREATE TABLE pt_kapuk_tiket_timeline (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  tiket_id    INT NOT NULL,
  event_type  VARCHAR(50) NOT NULL,
  note        VARCHAR(500) NULL,
  actor_type  ENUM('ADMIN','TEKNISI','SYSTEM') NOT NULL DEFAULT 'SYSTEM',
  actor_id    INT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tiket_id) REFERENCES pt_kapuk_tiket(id) ON DELETE CASCADE,
  INDEX idx_tiket_timeline (tiket_id, created_at)
) ENGINE=InnoDB;

-- ───────────────────────────────────────────────────────────
-- 9. FILE / FOTO BUKTI — lampiran bebas per tiket (mis. foto sebelum/
--    sesudah dikerjakan). Sengaja generik, gak dipisah kategori kayak
--    be-oki-app karena gak ada lagi BA checklist/biaya yang butuh itu.
-- ───────────────────────────────────────────────────────────
CREATE TABLE pt_kapuk_tiket_files (
  id                      INT AUTO_INCREMENT PRIMARY KEY,
  tiket_id                INT NOT NULL,
  judul                   VARCHAR(200) NULL,
  file_url                VARCHAR(500) NOT NULL,
  uploaded_by_admin_id    INT NULL,
  uploaded_by_teknisi_id  INT NULL,
  created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tiket_id)               REFERENCES pt_kapuk_tiket(id) ON DELETE CASCADE,
  FOREIGN KEY (uploaded_by_admin_id)   REFERENCES pt_kapuk_admins(id),
  FOREIGN KEY (uploaded_by_teknisi_id) REFERENCES pt_kapuk_teknisi(id)
) ENGINE=InnoDB;

-- FK checks dinyalain lagi -- semua tabel udah selesai dibikin.
SET FOREIGN_KEY_CHECKS = 1;

-- ───────────────────────────────────────────────────────────
-- SEED DATA MINIMAL (password semua akun contoh: "password123")
-- ───────────────────────────────────────────────────────────
INSERT INTO pt_kapuk_admins (username, password, nama, role) VALUES
  ('admin', '$2b$10$.gI0Q57pTsFDt0cbQBpDb.qq2m6KPafkaQOBaQwnpp1uIbUcXnM62', 'Administrator', 'ADMIN');

INSERT INTO pt_kapuk_teknisi (username, password, nama, no_hp, email, jabatan, departemen) VALUES
  ('teknisi1', '$2b$10$.gI0Q57pTsFDt0cbQBpDb.qq2m6KPafkaQOBaQwnpp1uIbUcXnM62', 'Andi Wijaya', '081212121212', 'andi@ptgokak.co.id', 'Teknisi Mesin', 'Produksi'),
  ('teknisi2', '$2b$10$.gI0Q57pTsFDt0cbQBpDb.qq2m6KPafkaQOBaQwnpp1uIbUcXnM62', 'Budi Santoso', '081212121213', 'budi@ptgokak.co.id', 'Teknisi Listrik', 'Maintenance');

-- Area default buat MASA DEVELOPMENT -- dialihkan ke lokasi kantor
-- (Ruko Pesona View, Blok C7) sesuai arahan, BUKAN lokasi pabrik asli.
-- Bentuknya kotak kasar di sekitar titik ruko -- gambar ulang yang
-- presisi lewat halaman admin "Area Pabrik" begitu develop di lokasi asli.
INSERT INTO pt_kapuk_area (nama, deskripsi, is_primary, height, color, polygon, created_by) VALUES
  ('Kantor (dev sementara)', 'Ruko Pesona View Blok C7 -- ganti ke lokasi pabrik asli lewat halaman Area Pabrik', 1, 10, '#f59e0b',
   JSON_ARRAY(
     JSON_ARRAY(106.840688, -6.379983),
     JSON_ARRAY(106.840960, -6.379983),
     JSON_ARRAY(106.840960, -6.380146),
     JSON_ARRAY(106.840688, -6.380146),
     JSON_ARRAY(106.840688, -6.379983)
   ), 1);

-- Contoh assignment teknisi ke area (keduanya ditugaskan ke area default
-- di atas -- kalau nanti ada beberapa area, tinggal INSERT baris lagi,
-- 1 teknisi boleh punya banyak baris/area).
INSERT INTO pt_kapuk_teknisi_area (teknisi_id, area_id)
  SELECT t.id, a.id FROM pt_kapuk_teknisi t, pt_kapuk_area a
  WHERE t.username IN ('teknisi1', 'teknisi2') AND a.nama = 'Kantor (dev sementara)';
