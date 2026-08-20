-- ═══════════════════════════════════════════════════════════════════
-- PT GOKAK INDONESIA — CMMS & EMPLOYEE TRACKING SYSTEM
-- Schema database, prefix tabel: pt_gokak_
--
-- ⚠️  RESET TOTAL — DROP semua tabel pt_gokak_* / pt_kapuk_*
-- ═══════════════════════════════════════════════════════════════════

CREATE DATABASE IF NOT EXISTS pt_gokak_indonesia
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE pt_gokak_indonesia;

SET FOREIGN_KEY_CHECKS = 0;

-- Drop old tables if they exist
DROP TABLE IF EXISTS
  pt_kapuk_tiket_files, pt_kapuk_tiket_timeline, pt_kapuk_tiket_teknisi,
  pt_kapuk_tiket, pt_kapuk_teknisi_area, pt_kapuk_teknisi_lokasi,
  pt_kapuk_teknisi, pt_kapuk_area, pt_kapuk_admins,
  pt_kapuk_license_state, pt_kapuk_license_requests;

-- Drop new tables if they exist
DROP TABLE IF EXISTS
  pt_gokak_task_files, pt_gokak_task_timeline, pt_gokak_tasks,
  pt_gokak_pm_parameters, pt_gokak_machines, pt_gokak_task_categories,
  pt_gokak_user_locations, pt_gokak_users, pt_gokak_lines, pt_gokak_shifts;

-- ───────────────────────────────────────────────────────────
-- MASTER DATA
-- ───────────────────────────────────────────────────────────

-- 1. SHIFTS
CREATE TABLE pt_gokak_shifts (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  nama        VARCHAR(50) NOT NULL,
  start_time  TIME NOT NULL,
  end_time    TIME NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- 2. LINES / AREA PRODUKSI (menggantikan pt_kapuk_area)
CREATE TABLE pt_gokak_lines (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  nama        VARCHAR(150) NOT NULL,
  departemen  VARCHAR(150) NULL,
  deskripsi   VARCHAR(255) NULL,
  is_primary  TINYINT(1) NOT NULL DEFAULT 1,
  height      INT NOT NULL DEFAULT 10,
  color       VARCHAR(9) NOT NULL DEFAULT '#f59e0b',
  polygon     JSON NOT NULL,
  is_active   TINYINT(1) NOT NULL DEFAULT 1,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_line_primary (is_primary, is_active)
) ENGINE=InnoDB;

-- 3. USERS (menggabungkan admin & teknisi, mendukung role RBAC)
CREATE TABLE pt_gokak_users (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  username          VARCHAR(100) NOT NULL UNIQUE,
  password          VARCHAR(255) NOT NULL,
  nama              VARCHAR(150) NOT NULL,
  no_hp             VARCHAR(30)  NULL,
  email             VARCHAR(150) NULL,
  role              ENUM('ADMIN','LEADER','MEKANIK','EXECUTIVE') NOT NULL,
  line_id           INT NULL,            -- Scope untuk Leader & Mekanik
  status            ENUM('OFFLINE','ONLINE','ON_TASK') NOT NULL DEFAULT 'OFFLINE',
  latitude          DECIMAL(10,7) NULL,
  longitude         DECIMAL(10,7) NULL,
  last_location_at  DATETIME NULL,
  is_active         TINYINT(1) NOT NULL DEFAULT 1,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (line_id) REFERENCES pt_gokak_lines(id) ON DELETE SET NULL,
  INDEX idx_user_role (role),
  INDEX idx_user_status (status)
) ENGINE=InnoDB;

-- 4. RIWAYAT GPS USERS (untuk Mekanik/Leader yang di lapangan)
CREATE TABLE pt_gokak_user_locations (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id       INT NOT NULL,
  task_id       INT NULL,
  latitude      DECIMAL(10,7) NOT NULL,
  longitude     DECIMAL(10,7) NOT NULL,
  in_line       TINYINT(1) NOT NULL DEFAULT 0,
  line_id       INT NULL,
  recorded_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES pt_gokak_users(id) ON DELETE CASCADE,
  FOREIGN KEY (line_id) REFERENCES pt_gokak_lines(id) ON DELETE SET NULL,
  INDEX idx_user_time (user_id, recorded_at)
) ENGINE=InnoDB;

-- 5. TASK CATEGORIES (Jenis pekerjaan)
CREATE TABLE pt_gokak_task_categories (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  nama        VARCHAR(100) NOT NULL,
  deskripsi   VARCHAR(255) NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- 6. MACHINES / ASET
CREATE TABLE pt_gokak_machines (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  kode        VARCHAR(50) NOT NULL UNIQUE,
  nama        VARCHAR(150) NOT NULL,
  tipe        VARCHAR(100) NULL,
  merk        VARCHAR(100) NULL,
  line_id     INT NULL,
  last_pm_at  DATE NULL,
  is_active   TINYINT(1) NOT NULL DEFAULT 1,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (line_id) REFERENCES pt_gokak_lines(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- 7. PM PARAMETERS (Preventive Maintenance)
CREATE TABLE pt_gokak_pm_parameters (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  machine_tipe    VARCHAR(100) NOT NULL,
  cycle_days      INT NOT NULL,
  checklist_json  JSON NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ───────────────────────────────────────────────────────────
-- TRANSAKSI
-- ───────────────────────────────────────────────────────────

-- 8. TASKS (Pengganti tiket, mendukung verifikasi Leader)
CREATE TABLE pt_gokak_tasks (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  task_no               VARCHAR(20) NOT NULL UNIQUE,
  judul                 VARCHAR(200) NOT NULL,
  deskripsi             TEXT NULL,
  category_id           INT NULL,
  priority              ENUM('LOW','MEDIUM','HIGH') NOT NULL DEFAULT 'MEDIUM',
  
  line_id               INT NULL,            -- Scope lokasi task
  machine_id            INT NULL,            -- Mesin yang dikerjakan (opsional)
  
  tanggal_mulai         DATE NULL,
  tanggal_selesai       DATE NULL,
  latitude              DECIMAL(10,7) NULL,
  longitude             DECIMAL(10,7) NULL,

  status                ENUM('OPEN','IN_PROGRESS','SELESAI','TERVERIFIKASI','CANCELLED') NOT NULL DEFAULT 'OPEN',
  pm_checklist_result   JSON NULL,           -- Jawaban checklist jika ini task PM

  created_by_id         INT NOT NULL,        -- Bisa Leader (Top-down) atau Mekanik (Bottom-up)
  assigned_to_id        INT NULL,            -- Mekanik yang mengerjakan
  verified_by_id        INT NULL,            -- Leader yang memverifikasi
  
  created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  selesai_at            DATETIME NULL,       -- Waktu mekanik klik selesai
  verified_at           DATETIME NULL,       -- Waktu leader klik verifikasi

  FOREIGN KEY (category_id)    REFERENCES pt_gokak_task_categories(id) ON DELETE SET NULL,
  FOREIGN KEY (line_id)        REFERENCES pt_gokak_lines(id) ON DELETE SET NULL,
  FOREIGN KEY (machine_id)     REFERENCES pt_gokak_machines(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by_id)  REFERENCES pt_gokak_users(id),
  FOREIGN KEY (assigned_to_id) REFERENCES pt_gokak_users(id),
  FOREIGN KEY (verified_by_id) REFERENCES pt_gokak_users(id),
  INDEX idx_task_status (status),
  INDEX idx_task_created (created_at)
) ENGINE=InnoDB;

-- 9. TASK TIMELINE
CREATE TABLE pt_gokak_task_timeline (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  task_id     INT NOT NULL,
  event_type  VARCHAR(50) NOT NULL,
  note        VARCHAR(500) NULL,
  actor_id    INT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (task_id) REFERENCES pt_gokak_tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (actor_id) REFERENCES pt_gokak_users(id) ON DELETE SET NULL,
  INDEX idx_task_timeline (task_id, created_at)
) ENGINE=InnoDB;

-- 10. TASK FILES
CREATE TABLE pt_gokak_task_files (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  task_id         INT NOT NULL,
  judul           VARCHAR(200) NULL,
  file_url        VARCHAR(500) NOT NULL,
  uploaded_by_id  INT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (task_id) REFERENCES pt_gokak_tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (uploaded_by_id) REFERENCES pt_gokak_users(id)
) ENGINE=InnoDB;


SET FOREIGN_KEY_CHECKS = 1;

-- ───────────────────────────────────────────────────────────
-- SEED DATA MINIMAL
-- ───────────────────────────────────────────────────────────

-- 1. Shifts
INSERT INTO pt_gokak_shifts (nama, start_time, end_time) VALUES
  ('Shift A', '06:00:00', '14:00:00'),
  ('Shift B', '14:00:00', '22:00:00'),
  ('Shift C', '22:00:00', '06:00:00');

-- 2. Lines (Area)
INSERT INTO pt_gokak_lines (nama, departemen, deskripsi, is_primary, height, color, polygon) VALUES
  ('Line Spinning 1', 'Spinning', 'Area Spinning 1', 1, 10, '#3b82f6',
   JSON_ARRAY(
     JSON_ARRAY(106.840688, -6.379983),
     JSON_ARRAY(106.840960, -6.379983),
     JSON_ARRAY(106.840960, -6.380146),
     JSON_ARRAY(106.840688, -6.380146),
     JSON_ARRAY(106.840688, -6.379983)
   )),
  ('Line Weaving 1', 'Weaving', 'Area Weaving 1', 1, 10, '#ef4444',
   JSON_ARRAY(
     JSON_ARRAY(106.841000, -6.379900),
     JSON_ARRAY(106.841200, -6.379900),
     JSON_ARRAY(106.841200, -6.380100),
     JSON_ARRAY(106.841000, -6.380100),
     JSON_ARRAY(106.841000, -6.379900)
   ));

-- 3. Users
-- password "password123"
INSERT INTO pt_gokak_users (username, password, nama, role, line_id) VALUES
  ('admin', '$2b$10$.gI0Q57pTsFDt0cbQBpDb.qq2m6KPafkaQOBaQwnpp1uIbUcXnM62', 'Super Admin', 'ADMIN', NULL),
  ('exec1', '$2b$10$.gI0Q57pTsFDt0cbQBpDb.qq2m6KPafkaQOBaQwnpp1uIbUcXnM62', 'Bpk Direktur', 'EXECUTIVE', NULL),
  ('leader_spin1', '$2b$10$.gI0Q57pTsFDt0cbQBpDb.qq2m6KPafkaQOBaQwnpp1uIbUcXnM62', 'Leader Spinning 1', 'LEADER', 1),
  ('mekanik_spin1', '$2b$10$.gI0Q57pTsFDt0cbQBpDb.qq2m6KPafkaQOBaQwnpp1uIbUcXnM62', 'Mekanik Spinning 1', 'MEKANIK', 1),
  ('leader_weav1', '$2b$10$.gI0Q57pTsFDt0cbQBpDb.qq2m6KPafkaQOBaQwnpp1uIbUcXnM62', 'Leader Weaving 1', 'LEADER', 2),
  ('mekanik_weav1', '$2b$10$.gI0Q57pTsFDt0cbQBpDb.qq2m6KPafkaQOBaQwnpp1uIbUcXnM62', 'Mekanik Weaving 1', 'MEKANIK', 2);

-- 4. Task Categories
INSERT INTO pt_gokak_task_categories (nama) VALUES
  ('Perbaikan'), ('Preventive Maintenance'), ('Setting Mesin'), ('Cleaning');

-- 5. Machines
INSERT INTO pt_gokak_machines (kode, nama, tipe, merk, line_id) VALUES
  ('SPN-01', 'Mesin Ring Spinning 01', 'Ring Frame', 'Toyota', 1),
  ('SPN-02', 'Mesin Ring Spinning 02', 'Ring Frame', 'Toyota', 1),
  ('WVN-01', 'Mesin Loom 01', 'Air Jet Loom', 'Tsudakoma', 2);
CREATE TABLE IF NOT EXISTS pt_gokak_settings (setting_key VARCHAR(50) PRIMARY KEY, setting_value VARCHAR(255));
INSERT IGNORE INTO pt_gokak_settings (setting_key, setting_value) VALUES ('app_name', 'CMMS Gokak');
