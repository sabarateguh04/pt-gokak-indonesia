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
  const dateParam = req.query.date || new Date().toISOString().slice(0, 10);
  let from = req.query.from || dateParam + ' 00:00:00';
  let to = req.query.to || dateParam + ' 23:59:59';
  const q = req.query.q ? `%${req.query.q}%` : null;
  const shiftId = req.query.shift_id;

  try {
    if (shiftId) {
      const [[shift]] = await pool.query('SELECT start_time, end_time FROM pt_gokak_shifts WHERE id = ?', [shiftId]);
      if (shift) {
        from = `${dateParam} ${shift.start_time}`;
        if (shift.end_time < shift.start_time) {
          const nextDay = new Date(new Date(dateParam).getTime() + 86400000).toISOString().slice(0, 10);
          to = `${nextDay} ${shift.end_time}`;
        } else {
          to = `${dateParam} ${shift.end_time}`;
        }
      }
    }

    const whereSearch = q ? `AND (k.nama LIKE ? OR k.username LIKE ?)` : '';
    const searchParams = q ? [q, q] : [];

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM pt_gokak_users k WHERE k.is_active = 1 AND k.role = 'MEKANIK' ${whereSearch}`,
      searchParams,
    );

    const [rows] = await pool.query(
      `SELECT k.id, k.nama, k.role AS jabatan, NULL AS departemen, k.status,
              COUNT(l.id) * ? AS online_seconds,
              COALESCE(SUM(l.in_line), 0) * ? AS in_area_seconds,
              COALESCE(SUM(l.in_line = 0), 0) * ? AS out_area_seconds
       FROM pt_gokak_users k
       LEFT JOIN pt_gokak_user_locations l
         ON l.user_id = k.id AND l.recorded_at BETWEEN ? AND ?
       WHERE k.is_active = 1 AND k.role = 'MEKANIK' ${whereSearch}
       GROUP BY k.id, k.nama, k.role, k.status
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
      `SELECT recorded_at, in_line AS in_area FROM pt_gokak_user_locations
       WHERE user_id = ? AND recorded_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
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
  const shiftId = req.query.shift_id;
  let from = `${date} 00:00:00`;
  let to = `${date} 23:59:59`;

  try {
    if (shiftId) {
      const [[shift]] = await pool.query('SELECT start_time, end_time FROM pt_gokak_shifts WHERE id = ?', [shiftId]);
      if (shift) {
        from = `${date} ${shift.start_time}`;
        if (shift.end_time < shift.start_time) {
          const nextDay = new Date(new Date(date).getTime() + 86400000).toISOString().slice(0, 10);
          to = `${nextDay} ${shift.end_time}`;
        } else {
          to = `${date} ${shift.end_time}`;
        }
      }
    }

    const [[teknisi]] = await pool.query(`SELECT id, nama, role AS jabatan FROM pt_gokak_users WHERE id = ?`, [req.params.teknisiId]);
    if (!teknisi) return res.status(404).json({ success: false, message: 'Teknisi tidak ditemukan' });

    const [pings] = await pool.query(
      `SELECT recorded_at, in_line AS in_area FROM pt_gokak_user_locations
       WHERE user_id = ? AND recorded_at BETWEEN ? AND ?
       ORDER BY recorded_at ASC`,
      [req.params.teknisiId, from, to],
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
