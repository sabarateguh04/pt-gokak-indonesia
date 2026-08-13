const express = require('express');
const pool = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireAdmin);

/* ═══════════════════════════════════════════════════
   GET /api/dashboard/kpi
   Ringkasan angka buat kartu KPI di atas dashboard.
═══════════════════════════════════════════════════ */
router.get('/kpi', async (req, res) => {
  try {
    const [[tiketRow]] = await pool.query(`
      SELECT
        COUNT(*)                                    AS total_tiket,
        SUM(status = 'NEW')                          AS baru,
        SUM(status IN ('ASSIGNED','IN_PROGRESS'))     AS progress,
        SUM(status = 'DONE')                          AS selesai,
        SUM(status = 'CANCELLED')                     AS dibatalkan
      FROM pt_kapuk_tiket
    `);

    const [[teknisiRow]] = await pool.query(`
      SELECT
        COUNT(*)                AS total_teknisi,
        SUM(status = 'ONLINE')   AS online,
        SUM(status = 'ON_TASK')  AS on_task,
        SUM(status = 'OFFLINE')  AS offline
      FROM pt_kapuk_teknisi WHERE is_active = 1
    `);

    return res.json({ success: true, tiket_kpi: tiketRow, teknisi_kpi: teknisiRow });
  } catch (e) {
    console.error('[DASHBOARD kpi]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ═══════════════════════════════════════════════════
   GET /api/dashboard/monitoring
   Data buat peta + panel monitoring: posisi & status semua teknisi
   aktif (termasuk yang lagi OFFLINE, biar kelihatan siapa aja yang
   ada), tiket terbaru, aktivitas terbaru.
═══════════════════════════════════════════════════ */
router.get('/monitoring', async (req, res) => {
  try {
    const [teknisiLokasi] = await pool.query(`
      SELECT k.id, k.nama, k.jabatan, k.status, k.latitude, k.longitude, k.last_location_at,
             (SELECT t.judul FROM pt_kapuk_tiket_teknisi tt
                JOIN pt_kapuk_tiket t ON t.id = tt.tiket_id
                WHERE tt.teknisi_id = k.id AND t.status IN ('ASSIGNED','IN_PROGRESS')
                ORDER BY tt.assigned_at DESC LIMIT 1) AS tugas_sekarang
      FROM pt_kapuk_teknisi k
      WHERE k.is_active = 1
    `);

    const [recentTiket] = await pool.query(`
      SELECT t.id, t.tiket_no, t.judul, t.status, t.priority, t.created_at,
             (SELECT GROUP_CONCAT(k.nama SEPARATOR ', ')
                FROM pt_kapuk_tiket_teknisi tt JOIN pt_kapuk_teknisi k ON k.id = tt.teknisi_id
                WHERE tt.tiket_id = t.id) AS teknisi_nama
      FROM pt_kapuk_tiket t
      ORDER BY t.created_at DESC
      LIMIT 10
    `);

    const [recentActivities] = await pool.query(`
      SELECT tt.id, tt.tiket_id, t.tiket_no, tt.event_type, tt.note, tt.actor_type, tt.actor_id, tt.created_at
      FROM pt_kapuk_tiket_timeline tt
      JOIN pt_kapuk_tiket t ON t.id = tt.tiket_id
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
   Tiket per bulan, performa per teknisi.
═══════════════════════════════════════════════════ */
router.get('/analytics', async (req, res) => {
  try {
    const [tiketPerBulan] = await pool.query(`
      SELECT DATE_FORMAT(created_at, '%Y-%m') AS bulan, COUNT(*) AS total
      FROM pt_kapuk_tiket
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 12 MONTH)
      GROUP BY bulan
      ORDER BY bulan ASC
    `);

    const [teknisiPerformance] = await pool.query(`
      SELECT k.id, k.nama,
             COUNT(tt.tiket_id) AS total_tiket,
             SUM(t.status = 'DONE') AS total_selesai,
             ROUND(AVG(CASE WHEN t.status='DONE' THEN TIMESTAMPDIFF(MINUTE, t.created_at, t.selesai_at) END)) AS avg_durasi_menit
      FROM pt_kapuk_teknisi k
      LEFT JOIN pt_kapuk_tiket_teknisi tt ON tt.teknisi_id = k.id
      LEFT JOIN pt_kapuk_tiket t ON t.id = tt.tiket_id
      WHERE k.is_active = 1
      GROUP BY k.id, k.nama
      ORDER BY total_selesai DESC
    `);

    return res.json({
      success: true,
      tiket_per_bulan: tiketPerBulan,
      teknisi_performance: teknisiPerformance,
    });
  } catch (e) {
    console.error('[DASHBOARD analytics]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
