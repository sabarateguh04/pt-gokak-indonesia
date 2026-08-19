const express = require('express');
const pool = require('../db');
const { requireAuth, requireRoles } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Dashboard data bisa dilihat oleh ADMIN dan EXECUTIVE
const canViewDashboard = requireRoles('ADMIN', 'EXECUTIVE');

/* ═══════════════════════════════════════════════════
   GET /api/dashboard/kpi
   Ringkasan angka buat kartu KPI di atas dashboard.
═══════════════════════════════════════════════════ */
router.get('/kpi', canViewDashboard, async (req, res) => {
  try {
    const [[tiketRow]] = await pool.query(`
      SELECT
        COUNT(*)                                    AS total_tiket,
        SUM(status = 'OPEN')                         AS baru,
        SUM(status = 'IN_PROGRESS')                  AS progress,
        SUM(status = 'SELESAI')                      AS selesai,
        SUM(status = 'TERVERIFIKASI')                AS terverifikasi
      FROM pt_gokak_tasks
    `);

    const [[teknisiRow]] = await pool.query(`
      SELECT
        COUNT(*)                 AS total_teknisi,
        SUM(status = 'ONLINE')   AS online,
        SUM(status = 'ON_TASK')  AS on_task,
        SUM(status = 'OFFLINE')  AS offline
      FROM pt_gokak_users WHERE is_active = 1 AND role = 'MEKANIK'
    `);

    return res.json({ success: true, tiket_kpi: tiketRow, teknisi_kpi: teknisiRow });
  } catch (e) {
    console.error('[DASHBOARD kpi]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ═══════════════════════════════════════════════════
   GET /api/dashboard/monitoring
   Data buat peta + panel monitoring: posisi & status semua mekanik
   aktif (termasuk yang lagi OFFLINE, biar kelihatan siapa aja yang
   ada), tiket terbaru, aktivitas terbaru.
═══════════════════════════════════════════════════ */
router.get('/monitoring', canViewDashboard, async (req, res) => {
  try {
    const [teknisiLokasi] = await pool.query(`
      SELECT u.id, u.nama, u.role, u.status, u.latitude, u.longitude, u.last_location_at,
             (SELECT t.judul FROM pt_gokak_tasks t
              WHERE t.assigned_to_id = u.id AND t.status IN ('OPEN','IN_PROGRESS')
              ORDER BY t.created_at DESC LIMIT 1) AS tugas_sekarang
      FROM pt_gokak_users u
      WHERE u.is_active = 1 AND u.role IN ('MEKANIK', 'LEADER')
    `);

    const [recentTiket] = await pool.query(`
      SELECT t.id, t.task_no, t.judul, t.status, t.priority, t.created_at,
             u.nama AS teknisi_nama
      FROM pt_gokak_tasks t
      LEFT JOIN pt_gokak_users u ON u.id = t.assigned_to_id
      ORDER BY t.created_at DESC
      LIMIT 10
    `);

    const [recentActivities] = await pool.query(`
      SELECT tt.id, tt.task_id, t.task_no, tt.event_type, tt.note, u.nama AS actor_nama, tt.created_at
      FROM pt_gokak_task_timeline tt
      JOIN pt_gokak_tasks t ON t.id = tt.task_id
      LEFT JOIN pt_gokak_users u ON u.id = tt.actor_id
      ORDER BY tt.created_at DESC
      LIMIT 20
    `);

    return res.json({
      success: true,
      teknisi_lokasi: teknisiLokasi,
      recent_tiket: recentTiket,
      recent_activities: recentActivities,
    });
  } catch (e) {
    console.error('[DASHBOARD monitoring]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ═══════════════════════════════════════════════════
   GET /api/dashboard/analytics
   Tiket per bulan, performa per mekanik.
═══════════════════════════════════════════════════ */
router.get('/analytics', canViewDashboard, async (req, res) => {
  try {
    const [tiketPerBulan] = await pool.query(`
      SELECT DATE_FORMAT(created_at, '%Y-%m') AS bulan, COUNT(*) AS total
      FROM pt_gokak_tasks
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 12 MONTH)
      GROUP BY bulan
      ORDER BY bulan ASC
    `);

    const [tiketPerTeknisi] = await pool.query(`
      SELECT u.nama, COUNT(t.id) AS total_tiket
      FROM pt_gokak_users u
      LEFT JOIN pt_gokak_tasks t ON t.assigned_to_id = u.id
      WHERE u.role = 'MEKANIK'
      GROUP BY u.id
      ORDER BY total_tiket DESC
    `);

    return res.json({ success: true, tiket_per_bulan: tiketPerBulan, tiket_per_teknisi: tiketPerTeknisi });
  } catch (e) {
    console.error('[DASHBOARD analytics]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ═══════════════════════════════════════════════════
   GET /api/dashboard/advanced
   Data khusus untuk layout dashboard baru (Mesin kendala tertinggi,
   Statistik kendala, Absensi simulasi).
═══════════════════════════════════════════════════ */
router.get('/advanced', canViewDashboard, async (req, res) => {
  try {
    // 1. Distribusi Mesin (Mesin Kendala Tertinggi)
    const [mesinKendala] = await pool.query(`
      SELECT m.nama, COUNT(t.id) as total_kendala
      FROM pt_gokak_machines m
      JOIN pt_gokak_tasks t ON t.machine_id = m.id
      GROUP BY m.id
      ORDER BY total_kendala DESC
      LIMIT 7
    `);

    // 2. Statistik Kendala (Bar Chart: Simulasi berdasar Kategori)
    // Asumsi: 'Mekanik' -> Machine Down, 'Elektrik' -> Anomali Proses dsb.
    // Untuk real, kita ambil count tiket per tanggal 15 hari terakhir
    const [statsResult] = await pool.query(`
      SELECT 
        DATE_FORMAT(created_at, '%d') as hari,
        SUM(CASE WHEN category_id = 1 THEN 1 ELSE 0 END) as machine_down,
        SUM(CASE WHEN category_id != 1 THEN 1 ELSE 0 END) as anomali_proses
      FROM pt_gokak_tasks
      WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 15 DAY)
      GROUP BY DATE(created_at)
      ORDER BY DATE(created_at) ASC
    `);

    // 3. Absensi Shift (Simulasi dari user aktif)
    const [usersShift] = await pool.query(`
      SELECT nama, id as nik, 
             '07:45:00' as datang, '17:01:05' as pulang
      FROM pt_gokak_users
      WHERE is_active = 1 AND role = 'MEKANIK'
      LIMIT 5
    `);

    return res.json({
      success: true,
      mesin_kendala: mesinKendala,
      statistik: statsResult,
      absensi: usersShift
    });
  } catch (e) {
    console.error('[DASHBOARD advanced]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
