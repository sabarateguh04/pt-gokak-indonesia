const express = require('express');
const pool = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const {
  PING_INTERVAL_SECONDS, summarizeByDay,
  buildOnlineSessions, buildInAreaSessions, buildOutAreaSessions, filterSignificantSessions,
} = require('../helpers/kehadiran');

const MIN_SESSION_SECONDS_TO_SHOW = 60; // sesi < 1 menit disembunyikan dari daftar (noise GPS/network)

const router = express.Router();
router.use(requireAuth, requireAdmin);

/* ═══════════════════════════════════════════════════
   GET /api/kpi/ringkasan?from=&to=&q=&page=&pageSize=
   Tabel ringkasan SEMUA karyawan buat 1 rentang tanggal (dipakai buat
   "hari ini / minggu ini / bulan ini" dari frontend). Didesain buat
   skala 500-1000 karyawan -- makanya PAKE PENDEKATAN CEPAT:
   online_seconds ≈ COUNT(ping) * PING_INTERVAL_SECONDS (bukan hitung
   gap presisi kayak endpoint /harian & /heatmap di bawah). Ini valid
   karena ping emang dikirim tiap PING_INTERVAL_SECONDS selama online --
   gap yang lama otomatis gak nambah hitungan (gak ada ping = gak
   dihitung), cuma gak sepresisi yang per-detik. Buat detail akurat 1
   karyawan, pakai /harian.

   Query COUNT(*) di endpoint ini masih query mentah tiap request (gak
   ada rollup harian, lihat README bagian 15) -- di skala 500-1000
   karyawan yang online bareng, pantau performanya; kalau mulai berat,
   itu titik yang paling nunjuk buat dikasih tabel rollup harian duluan.
═══════════════════════════════════════════════════ */
router.get('/ringkasan', async (req, res) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const pageSize = Math.min(Number(req.query.pageSize) || 50, 200);
  const offset = (page - 1) * pageSize;
  const from = req.query.from || new Date().toISOString().slice(0, 10) + ' 00:00:00';
  const to = req.query.to || new Date().toISOString().slice(0, 10) + ' 23:59:59';
  const q = req.query.q ? `%${req.query.q}%` : null;

  try {
    const whereSearch = q ? `AND (k.nama LIKE ? OR k.username LIKE ?)` : '';
    const searchParams = q ? [q, q] : [];

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM pt_kapuk_teknisi k WHERE k.is_active = 1 ${whereSearch}`,
      searchParams,
    );

    const [rows] = await pool.query(
      `SELECT k.id, k.nama, k.jabatan, k.departemen, k.status,
              COUNT(l.id) * ? AS online_seconds,
              COALESCE(SUM(l.in_area), 0) * ? AS in_area_seconds,
              COALESCE(SUM(l.in_area = 0), 0) * ? AS out_area_seconds
       FROM pt_kapuk_teknisi k
       LEFT JOIN pt_kapuk_teknisi_lokasi l
         ON l.teknisi_id = k.id AND l.recorded_at BETWEEN ? AND ?
       WHERE k.is_active = 1 ${whereSearch}
       GROUP BY k.id, k.nama, k.jabatan, k.departemen, k.status
       ORDER BY online_seconds DESC, k.nama ASC
       LIMIT ? OFFSET ?`,
      [PING_INTERVAL_SECONDS, PING_INTERVAL_SECONDS, PING_INTERVAL_SECONDS, from, to, ...searchParams, pageSize, offset],
    );

    return res.json({ success: true, teknisi: rows, total, page, pageSize });
  } catch (e) {
    console.error('[KPI ringkasan]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ═══════════════════════════════════════════════════
   GET /api/kpi/heatmap/:teknisiId?days=90
   Data buat kalender heatmap ala GitHub -- total per hari, N hari
   terakhir (default 90 -- makin panjang, makin berat karena ambil
   ping mentah 1 karyawan). Hari tanpa data tetep muncul (nilainya 0)
   biar grid kalendernya gak bolong.
═══════════════════════════════════════════════════ */
router.get('/heatmap/:teknisiId', async (req, res) => {
  const days = Math.min(Number(req.query.days) || 90, 366);
  try {
    const [pings] = await pool.query(
      `SELECT recorded_at, in_area FROM pt_kapuk_teknisi_lokasi
       WHERE teknisi_id = ? AND recorded_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       ORDER BY recorded_at ASC`,
      [req.params.teknisiId, days - 1],
    );

    const byDay = summarizeByDay(pings);

    // Isi semua tanggal dalam rentang (termasuk yang 0) biar grid utuh
    const result = [];
    const today = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const v = byDay.get(key) || { online_seconds: 0, in_area_seconds: 0, out_area_seconds: 0 };
      result.push({ date: key, ...v });
    }

    return res.json({ success: true, days: result });
  } catch (e) {
    console.error('[KPI heatmap]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ═══════════════════════════════════════════════════
   GET /api/kpi/harian/:teknisiId?date=YYYY-MM-DD
   Detail 1 hari: total online / di-dalam-area / di-luar-area, PLUS
   TIGA daftar rentang waktu (buat ditampilin sebagai timeline di
   halaman Kehadiran): kapan online (apapun posisinya), kapan online
   DAN di dalam area, kapan online tapi di LUAR area (buat investigasi
   admin).

   Sesi yang durasinya < MIN_SESSION_SECONDS_TO_SHOW (noise blip GPS/
   network, bukan kejadian beneran) DIBUANG dari daftar yang dibalikin
   biar gak kepanjangan/berantakan -- tapi jumlahnya tetep dilaporin
   lewat *_hidden_count biar admin tau ada yang disembunyikan. Total
   detik di atas (online_seconds dkk) TETEP presisi, gak kepengaruh
   penyaringan ini (dihitung terpisah lewat summarizeByDay).
═══════════════════════════════════════════════════ */
router.get('/harian/:teknisiId', async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  try {
    const [[teknisi]] = await pool.query(`SELECT id, nama FROM pt_kapuk_teknisi WHERE id = ?`, [req.params.teknisiId]);
    if (!teknisi) return res.status(404).json({ success: false, message: 'Teknisi tidak ditemukan' });

    const [pings] = await pool.query(
      `SELECT recorded_at, in_area FROM pt_kapuk_teknisi_lokasi
       WHERE teknisi_id = ? AND recorded_at BETWEEN ? AND ?
       ORDER BY recorded_at ASC`,
      [req.params.teknisiId, `${date} 00:00:00`, `${date} 23:59:59`],
    );

    const byDay = summarizeByDay(pings);
    const totals = byDay.get(date) || { online_seconds: 0, in_area_seconds: 0, out_area_seconds: 0 };

    const allOnline = buildOnlineSessions(pings);
    const allInArea = buildInAreaSessions(pings);
    const allOutArea = buildOutAreaSessions(pings);
    const onlineSessions = filterSignificantSessions(allOnline, MIN_SESSION_SECONDS_TO_SHOW);
    const inAreaSessions = filterSignificantSessions(allInArea, MIN_SESSION_SECONDS_TO_SHOW);
    const outAreaSessions = filterSignificantSessions(allOutArea, MIN_SESSION_SECONDS_TO_SHOW);

    return res.json({
      success: true,
      teknisi,
      date,
      ping_count: pings.length,
      ...totals,
      online_sessions: onlineSessions,
      online_sessions_hidden_count: allOnline.length - onlineSessions.length,
      in_area_sessions: inAreaSessions,
      in_area_sessions_hidden_count: allInArea.length - inAreaSessions.length,
      out_area_sessions: outAreaSessions,
      out_area_sessions_hidden_count: allOutArea.length - outAreaSessions.length,
    });
  } catch (e) {
    console.error('[KPI harian]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
