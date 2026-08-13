const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { emitToDashboard } = require('../socket');
const { requireAuth, requireAdmin, requireTeknisi } = require('../middleware/auth');
const { getPrimaryAreasCached } = require('./area.route');
const { classifyPoint } = require('../helpers/geo');

const router = express.Router();

const PROFILE_FIELDS = ['nama', 'no_hp', 'email', 'jabatan', 'departemen', 'foto_url', 'is_active'];

const PROFILE_SELECT = `id, username, nama, no_hp, email, jabatan, departemen, foto_url,
  status, latitude, longitude, last_location_at, is_active, created_at`;

// Semua endpoint teknisi wajib login (admin ATAU teknisi yang bersangkutan
// buat ubah status/lokasi dirinya sendiri).
router.use(requireAuth);

/* GET /api/teknisi?status=ONLINE — admin lihat semua teknisi (buat peta & list) */
router.get('/', requireAdmin, async (req, res) => {
  const { status } = req.query;
  try {
    let sql = `SELECT k.*,
        (SELECT GROUP_CONCAT(a.nama SEPARATOR ', ')
           FROM pt_kapuk_teknisi_area ka JOIN pt_kapuk_area a ON a.id = ka.area_id
           WHERE ka.teknisi_id = k.id) AS area_nama
      FROM (SELECT ${PROFILE_SELECT} FROM pt_kapuk_teknisi WHERE is_active = 1`;
    const params = [];
    if (status) { sql += ` AND status = ?`; params.push(status); }
    sql += `) k ORDER BY nama ASC`;
    const [rows] = await pool.query(sql, params);
    return res.json({ success: true, teknisi: rows });
  } catch (e) {
    console.error('[TEKNISI list]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* GET /api/teknisi/:id */
router.get('/:id', async (req, res) => {
  // teknisi cuma boleh lihat profil dirinya sendiri, admin boleh lihat siapa aja
  if (req.user.type === 'teknisi' && Number(req.user.id) !== Number(req.params.id)) {
    return res.status(403).json({ success: false, message: 'Tidak boleh lihat profil teknisi lain' });
  }
  try {
    const [rows] = await pool.query(`SELECT ${PROFILE_SELECT} FROM pt_kapuk_teknisi WHERE id = ?`, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Teknisi tidak ditemukan' });

    const [perf] = await pool.query(
      `SELECT
         COUNT(tt.tiket_id) AS total_tiket,
         SUM(t.status = 'DONE') AS total_selesai,
         AVG(TIMESTAMPDIFF(MINUTE, t.created_at, t.selesai_at)) AS avg_durasi_menit
       FROM pt_kapuk_tiket_teknisi tt
       JOIN pt_kapuk_tiket t ON t.id = tt.tiket_id
       WHERE tt.teknisi_id = ?`,
      [req.params.id],
    );

    const [areas] = await pool.query(
      `SELECT a.id, a.nama, a.color, a.is_primary
       FROM pt_kapuk_teknisi_area ka JOIN pt_kapuk_area a ON a.id = ka.area_id
       WHERE ka.teknisi_id = ? ORDER BY a.nama ASC`,
      [req.params.id],
    );

    return res.json({ success: true, teknisi: rows[0], performance: perf[0], area: areas });
  } catch (e) {
    console.error('[TEKNISI detail]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* POST /api/teknisi — hanya admin yang boleh tambah akun teknisi baru */
router.post('/', requireAdmin, async (req, res) => {
  const { username, password, ...profile } = req.body;
  if (!username || !password || !profile.nama) {
    return res.status(400).json({ success: false, message: 'username, password, nama wajib diisi' });
  }
  try {
    const [existing] = await pool.query(`SELECT id FROM pt_kapuk_teknisi WHERE username = ?`, [username]);
    if (existing.length > 0) {
      return res.status(409).json({ success: false, message: 'Username sudah dipakai' });
    }
    const hash = await bcrypt.hash(password, 10);
    const cols = ['username', 'password', ...PROFILE_FIELDS.filter(f => f !== 'is_active')];
    const values = cols.map(f => {
      if (f === 'username') return username;
      if (f === 'password') return hash;
      return profile[f] === undefined || profile[f] === '' ? null : profile[f];
    });
    const [result] = await pool.query(
      `INSERT INTO pt_kapuk_teknisi (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      values,
    );
    return res.json({ success: true, teknisiId: result.insertId });
  } catch (e) {
    console.error('[TEKNISI create]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* PUT /api/teknisi/:id — hanya admin (edit profil / nonaktifkan akun) */
router.put('/:id', requireAdmin, async (req, res) => {
  const b = req.body;
  try {
    const values = PROFILE_FIELDS.map(f => {
      if (f === 'is_active') return b.is_active === undefined ? 1 : b.is_active;
      return b[f] === undefined || b[f] === '' ? null : b[f];
    });
    await pool.query(
      `UPDATE pt_kapuk_teknisi SET ${PROFILE_FIELDS.map(f => `${f}=?`).join(', ')} WHERE id = ?`,
      [...values, req.params.id],
    );
    if (b.password) {
      const hash = await bcrypt.hash(b.password, 10);
      await pool.query(`UPDATE pt_kapuk_teknisi SET password = ? WHERE id = ?`, [hash, req.params.id]);
    }
    return res.json({ success: true, message: 'Teknisi berhasil diupdate' });
  } catch (e) {
    console.error('[TEKNISI update]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ═══════════════════════════════════════════════════
   POST /api/teknisi/:id/status
   Teknisi hanya boleh ubah status DIRINYA SENDIRI.
   body: { status: 'OFFLINE' | 'ONLINE' | 'ON_TASK' }
═══════════════════════════════════════════════════ */
router.post('/:id/status', requireTeknisi, async (req, res) => {
  const { status } = req.body;
  if (!['OFFLINE', 'ONLINE', 'ON_TASK'].includes(status)) {
    return res.status(400).json({ success: false, message: 'status tidak valid' });
  }
  if (Number(req.user.id) !== Number(req.params.id)) {
    return res.status(403).json({ success: false, message: 'Tidak boleh ubah status teknisi lain' });
  }
  try {
    await pool.query(`UPDATE pt_kapuk_teknisi SET status = ? WHERE id = ?`, [status, req.params.id]);
    emitToDashboard('teknisi-status', { teknisiId: Number(req.params.id), status });
    return res.json({ success: true, message: `Status diubah ke ${status}` });
  } catch (e) {
    console.error('[TEKNISI status]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ═══════════════════════════════════════════════════
   POST /api/teknisi/:id/location
   GPS ping berkala selama status ONLINE/ON_TASK.
   body: { latitude, longitude, tiketId? }
═══════════════════════════════════════════════════ */
router.post('/:id/location', requireTeknisi, async (req, res) => {
  const { latitude, longitude, tiketId } = req.body;
  if (latitude === undefined || longitude === undefined) {
    return res.status(400).json({ success: false, message: 'latitude & longitude wajib diisi' });
  }
  if (Number(req.user.id) !== Number(req.params.id)) {
    return res.status(403).json({ success: false, message: 'Tidak boleh kirim lokasi atas nama teknisi lain' });
  }

  try {
    const [rows] = await pool.query(`SELECT status FROM pt_kapuk_teknisi WHERE id = ?`, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Teknisi tidak ditemukan' });

    if (rows[0].status === 'OFFLINE') {
      return res.status(409).json({
        success: false,
        message: 'Teknisi berstatus OFFLINE — set status ke ONLINE dulu sebelum kirim lokasi',
      });
    }

    // Cek posisi ini masuk area pabrik (primary) atau bukan -- disnapshot
    // SEKARANG, bukan dihitung ulang belakangan, biar histori KPI kehadiran
    // gak berubah kalau poligon area diedit admin di kemudian hari.
    const primaryAreas = await getPrimaryAreasCached();
    const { inArea, areaId } = classifyPoint(Number(longitude), Number(latitude), primaryAreas);

    const now = new Date();
    await pool.query(
      `UPDATE pt_kapuk_teknisi SET latitude=?, longitude=?, last_location_at=? WHERE id=?`,
      [latitude, longitude, now, req.params.id],
    );
    await pool.query(
      `INSERT INTO pt_kapuk_teknisi_lokasi (teknisi_id, tiket_id, latitude, longitude, in_area, area_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [req.params.id, tiketId || null, latitude, longitude, inArea ? 1 : 0, areaId],
    );

    emitToDashboard('teknisi-location', {
      teknisiId: Number(req.params.id), latitude, longitude, tiketId: tiketId || null, recordedAt: now, inArea,
    });

    return res.json({ success: true });
  } catch (e) {
    console.error('[TEKNISI location]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* GET /api/teknisi/:id/lokasi-history?from=&to=&limit=200 — admin lihat
   trail pergerakan teknisi (buat playback di peta) */
router.get('/:id/lokasi-history', requireAdmin, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  try {
    let sql = `SELECT id, latitude, longitude, tiket_id, recorded_at
               FROM pt_kapuk_teknisi_lokasi WHERE teknisi_id = ?`;
    const params = [req.params.id];
    if (req.query.from) { sql += ` AND recorded_at >= ?`; params.push(req.query.from); }
    if (req.query.to)   { sql += ` AND recorded_at <= ?`; params.push(req.query.to); }
    sql += ` ORDER BY recorded_at DESC LIMIT ?`;
    params.push(limit);
    const [rows] = await pool.query(sql, params);
    return res.json({ success: true, lokasi: rows });
  } catch (e) {
    console.error('[TEKNISI lokasi-history]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ═══════════════════════════════════════════════════
   POST /api/teknisi/:id/area — admin set area kerja teknisi ini.
   body: { area_ids: [1,3] } -- REPLACE ALL (bukan nambah), simpel &
   gak ambigu buat UI checkbox di halaman Teknisi. Kirim [] buat
   ngelepas semua area.
═══════════════════════════════════════════════════ */
router.post('/:id/area', requireAdmin, async (req, res) => {
  const areaIds = Array.isArray(req.body.area_ids) ? req.body.area_ids.filter(Boolean) : [];
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(`DELETE FROM pt_kapuk_teknisi_area WHERE teknisi_id = ?`, [req.params.id]);
    for (const areaId of areaIds) {
      await conn.query(`INSERT INTO pt_kapuk_teknisi_area (teknisi_id, area_id) VALUES (?, ?)`, [req.params.id, areaId]);
    }
    await conn.commit();
    return res.json({ success: true, message: 'Area kerja teknisi berhasil diupdate' });
  } catch (e) {
    await conn.rollback();
    console.error('[TEKNISI area]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    conn.release();
  }
});

module.exports = router;
