const express = require('express');
const pool = require('../db');
const { emitToDashboard, emitToTeknisi } = require('../socket');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { handleUploadMultiple } = require('../middleware/upload');

const router = express.Router();
router.use(requireAuth);

/* Helper: generate nomor tiket harian, format TKT-YYYYMMDD-XXX */
async function generateTiketNo() {
  const today = new Date();
  const ymd = today.toISOString().slice(0, 10).replace(/-/g, '');
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS n FROM pt_kapuk_tiket WHERE tiket_no LIKE ?`,
    [`TKT-${ymd}-%`],
  );
  const seq = String(row.n + 1).padStart(3, '0');
  return `TKT-${ymd}-${seq}`;
}

/* Helper: teknisi cuma boleh pakai area yang UDAH DI-SET ADMIN buat dia
   sendiri (lihat pt_kapuk_teknisi_area, dikelola dari halaman admin
   Teknisi). Admin sendiri gak dibatasi ini -- dia yang nentuin
   assignment-nya, jadi bebas pilih area apapun yang aktif. Balikin
   true kalau areaId null/kosong (opsional, boleh gak diisi). */
async function isAreaAllowedForTeknisi(teknisiId, areaId) {
  if (!areaId) return true;
  const [[row]] = await pool.query(
    `SELECT 1 AS ok FROM pt_kapuk_teknisi_area WHERE teknisi_id = ? AND area_id = ? LIMIT 1`,
    [teknisiId, areaId],
  );
  return !!row;
}

/* Helper: tulis satu baris ke tiket_timeline + broadcast realtime.
   Dashboard admin selalu dapet update; kalau ada teknisi yang lagi
   assigned di tiket ini, mereka juga dapet ping ke room pribadinya
   (biar halaman detail tugas di HP mereka auto-refresh). */
async function logTimeline(tiketId, eventType, note, actorType = 'SYSTEM', actorId = null) {
  await pool.query(
    `INSERT INTO pt_kapuk_tiket_timeline (tiket_id, event_type, note, actor_type, actor_id) VALUES (?, ?, ?, ?, ?)`,
    [tiketId, eventType, note || null, actorType, actorId],
  );

  emitToDashboard('tiket-update', { tiketId: Number(tiketId), eventType });
  try {
    const [teknisiRows] = await pool.query(
      `SELECT teknisi_id FROM pt_kapuk_tiket_teknisi WHERE tiket_id = ?`, [tiketId],
    );
    teknisiRows.forEach(t => emitToTeknisi(t.teknisi_id, 'tiket-update', { tiketId: Number(tiketId), eventType }));
  } catch (e) {
    console.error('[NOTIF tiket-update]', e.message);
  }
}

/* Helper: ambil 1 tiket + teknisi yang di-assign + timeline + file.
   created_by bisa admin ATAU teknisi (self-service) -- di-unify jadi
   created_by_nama/created_by_type biar gampang dipakai FE. */
async function getTiketDetail(tiketId) {
  const [rows] = await pool.query(
    `SELECT t.*,
            ar.nama AS area_nama, ar.color AS area_color,
            ad.nama AS created_by_admin_nama,
            kt.nama AS created_by_teknisi_nama
     FROM pt_kapuk_tiket t
     LEFT JOIN pt_kapuk_area ar ON ar.id = t.area_id
     LEFT JOIN pt_kapuk_admins ad ON ad.id = t.created_by_admin_id
     LEFT JOIN pt_kapuk_teknisi kt ON kt.id = t.created_by_teknisi_id
     WHERE t.id = ?`,
    [tiketId],
  );
  if (rows.length === 0) return null;
  const tiket = rows[0];
  tiket.created_by_nama = tiket.created_by_admin_nama || tiket.created_by_teknisi_nama || null;
  tiket.created_by_type = tiket.created_by_admin_id ? 'ADMIN' : 'TEKNISI';
  delete tiket.created_by_admin_nama;
  delete tiket.created_by_teknisi_nama;

  const [teknisi] = await pool.query(
    `SELECT tt.id AS relation_id, tt.assigned_at,
            k.id, k.nama, k.no_hp, k.jabatan, k.status, k.latitude, k.longitude, k.last_location_at
     FROM pt_kapuk_tiket_teknisi tt
     JOIN pt_kapuk_teknisi k ON k.id = tt.teknisi_id
     WHERE tt.tiket_id = ?
     ORDER BY tt.assigned_at ASC`,
    [tiketId],
  );

  const [timeline] = await pool.query(
    `SELECT * FROM pt_kapuk_tiket_timeline WHERE tiket_id = ? ORDER BY created_at DESC`, [tiketId],
  );

  const [files] = await pool.query(
    `SELECT * FROM pt_kapuk_tiket_files WHERE tiket_id = ? ORDER BY created_at DESC`, [tiketId],
  );

  return { ...tiket, teknisi_assigned: teknisi, timeline, files };
}

/* ═══════════════════════════════════════════════════
   GET /api/tiket?status=&priority=&teknisiId=  — admin (semua tiket)
   GET /api/tiket?mine=1                        — teknisi (tiket dia sendiri)
═══════════════════════════════════════════════════ */
router.get('/', async (req, res) => {
  try {
    if (req.user.type === 'teknisi') {
      const [rows] = await pool.query(
        `SELECT t.id, t.tiket_no, t.judul, t.kategori, t.priority, t.status,
                t.area_id, ar.nama AS area_nama, t.tanggal_mulai, t.tanggal_selesai,
                t.latitude, t.longitude, t.created_at, t.updated_at
         FROM pt_kapuk_tiket t
         JOIN pt_kapuk_tiket_teknisi tt ON tt.tiket_id = t.id
         LEFT JOIN pt_kapuk_area ar ON ar.id = t.area_id
         WHERE tt.teknisi_id = ?
         ORDER BY t.created_at DESC`,
        [req.user.id],
      );
      return res.json({ success: true, tiket: rows });
    }

    // admin: list semua, dengan filter opsional
    const { status, priority, teknisiId } = req.query;
    let sql = `
      SELECT t.id, t.tiket_no, t.judul, t.kategori, t.priority, t.status,
             t.area_id, ar.nama AS area_nama, t.tanggal_mulai, t.tanggal_selesai,
             t.latitude, t.longitude, t.created_at, t.updated_at,
             (SELECT GROUP_CONCAT(k.nama SEPARATOR ', ')
                FROM pt_kapuk_tiket_teknisi tt JOIN pt_kapuk_teknisi k ON k.id = tt.teknisi_id
                WHERE tt.tiket_id = t.id) AS teknisi_nama
      FROM pt_kapuk_tiket t
      LEFT JOIN pt_kapuk_area ar ON ar.id = t.area_id`;
    const params = [];
    const where = [];
    if (teknisiId) {
      sql += ` JOIN pt_kapuk_tiket_teknisi ttf ON ttf.tiket_id = t.id AND ttf.teknisi_id = ?`;
      params.push(teknisiId);
    }
    if (status)   { where.push(`t.status = ?`); params.push(status); }
    if (priority) { where.push(`t.priority = ?`); params.push(priority); }
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
    sql += ` ORDER BY t.created_at DESC`;

    const [rows] = await pool.query(sql, params);
    return res.json({ success: true, tiket: rows });
  } catch (e) {
    console.error('[TIKET list]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* GET /api/tiket/:id */
router.get('/:id', async (req, res) => {
  try {
    const tiket = await getTiketDetail(req.params.id);
    if (!tiket) return res.status(404).json({ success: false, message: 'Tiket tidak ditemukan' });

    if (req.user.type === 'teknisi') {
      const isAssigned = tiket.teknisi_assigned.some(k => Number(k.id) === Number(req.user.id));
      if (!isAssigned) {
        return res.status(403).json({ success: false, message: 'Tiket ini bukan tugas Anda' });
      }
    }

    return res.json({ success: true, tiket });
  } catch (e) {
    console.error('[TIKET detail]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ═══════════════════════════════════════════════════
   POST /api/tiket — bikin tiket baru. Bisa dibuat ADMIN *atau* TEKNISI
   sendiri (self-service).
   body: { judul, deskripsi, kategori, priority, area_id, tanggal_mulai,
           tanggal_selesai, latitude, longitude, teknisi_ids: [1,2] }

   - Admin: teknisi_ids opsional -- kalau diisi, tiket langsung
     ASSIGNED (assign langsung, tanpa tawar-terima). area_id bebas
     pilih area aktif apapun (gak dibatasi assignment teknisi).
   - Teknisi: teknisi_ids DIABAIKAN -- tiket otomatis di-assign ke
     dirinya sendiri (status langsung ASSIGNED). area_id WAJIB salah
     satu dari area yang udah di-set admin buat dia (pt_kapuk_teknisi_area).
═══════════════════════════════════════════════════ */
router.post('/', async (req, res) => {
  const { judul, deskripsi, kategori, priority, area_id, tanggal_mulai, tanggal_selesai, latitude, longitude } = req.body;
  if (!judul) {
    return res.status(400).json({ success: false, message: 'judul wajib diisi' });
  }

  const isTeknisi = req.user.type === 'teknisi';
  if (isTeknisi) {
    const allowed = await isAreaAllowedForTeknisi(req.user.id, area_id);
    if (!allowed) {
      return res.status(403).json({ success: false, message: 'Area kerja itu belum di-set admin untuk Anda' });
    }
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const tiketNo = await generateTiketNo();
    // Admin bebas pilih teknisi_ids; teknisi yang bikin sendiri = self-assign, gak baca body.
    const teknisiList = isTeknisi ? [req.user.id] : (Array.isArray(req.body.teknisi_ids) ? req.body.teknisi_ids.filter(Boolean) : []);
    const status = teknisiList.length ? 'ASSIGNED' : 'NEW';

    const [result] = await conn.query(
      `INSERT INTO pt_kapuk_tiket
         (tiket_no, judul, deskripsi, kategori, priority, area_id, tanggal_mulai, tanggal_selesai,
          latitude, longitude, status, created_by_admin_id, created_by_teknisi_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tiketNo, judul, deskripsi || null, kategori || 'PERBAIKAN', priority || 'MEDIUM',
        area_id || null, tanggal_mulai || null, tanggal_selesai || null,
        latitude || null, longitude || null, status,
        isTeknisi ? null : req.user.id, isTeknisi ? req.user.id : null,
      ],
    );
    const tiketId = result.insertId;

    for (const teknisiId of teknisiList) {
      await conn.query(
        `INSERT INTO pt_kapuk_tiket_teknisi (tiket_id, teknisi_id, assigned_by_admin_id, assigned_by_teknisi_id) VALUES (?, ?, ?, ?)`,
        [tiketId, teknisiId, isTeknisi ? null : req.user.id, isTeknisi ? req.user.id : null],
      );
    }

    await conn.commit();

    const actorType = isTeknisi ? 'TEKNISI' : 'ADMIN';
    await logTimeline(tiketId, 'CREATED', `Tiket dibuat oleh ${req.user.nama}${isTeknisi ? ' (self-service)' : ''}`, actorType, req.user.id);
    if (teknisiList.length) {
      await logTimeline(tiketId, 'ASSIGNED', isTeknisi
        ? `Di-assign ke diri sendiri saat dibuat`
        : `Langsung di-assign ke ${teknisiList.length} teknisi saat dibuat`, actorType, req.user.id);
      if (!isTeknisi) teknisiList.forEach(tid => emitToTeknisi(tid, 'tiket-baru', { tiketId, tiketNo, judul }));
    }

    return res.json({ success: true, tiketId, tiketNo });
  } catch (e) {
    await conn.rollback();
    console.error('[TIKET create]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    conn.release();
  }
});

/* ═══════════════════════════════════════════════════
   PUT /api/tiket/:id — edit, selagi belum DONE/CANCELLED.
   Boleh ADMIN (tiket manapun) ATAU TEKNISI yang di-assign ke tiket itu
   (sesuai arahan: lokasi/tanggal "bisa diedit sampe teknisi klik
   selesai"). Kalau yang edit teknisi, area_id tetap harus salah satu
   dari area yang di-set admin buat dia.
═══════════════════════════════════════════════════ */
router.put('/:id', async (req, res) => {
  const { judul, deskripsi, kategori, priority, area_id, tanggal_mulai, tanggal_selesai, latitude, longitude } = req.body;
  try {
    const [[tiket]] = await pool.query(`SELECT status FROM pt_kapuk_tiket WHERE id = ?`, [req.params.id]);
    if (!tiket) return res.status(404).json({ success: false, message: 'Tiket tidak ditemukan' });
    if (['DONE', 'CANCELLED'].includes(tiket.status)) {
      return res.status(409).json({ success: false, message: 'Tiket yang sudah selesai/dibatalkan tidak bisa diedit' });
    }

    if (req.user.type === 'teknisi') {
      const [[relasi]] = await pool.query(
        `SELECT id FROM pt_kapuk_tiket_teknisi WHERE tiket_id = ? AND teknisi_id = ?`,
        [req.params.id, req.user.id],
      );
      if (!relasi) return res.status(403).json({ success: false, message: 'Tiket ini bukan tugas Anda' });

      const allowed = await isAreaAllowedForTeknisi(req.user.id, area_id);
      if (!allowed) {
        return res.status(403).json({ success: false, message: 'Area kerja itu belum di-set admin untuk Anda' });
      }
    }

    await pool.query(
      `UPDATE pt_kapuk_tiket SET judul=?, deskripsi=?, kategori=?, priority=?, area_id=?, tanggal_mulai=?, tanggal_selesai=?, latitude=?, longitude=?
       WHERE id = ?`,
      [
        judul, deskripsi || null, kategori, priority, area_id || null,
        tanggal_mulai || null, tanggal_selesai || null, latitude || null, longitude || null,
        req.params.id,
      ],
    );
    const actorType = req.user.type === 'teknisi' ? 'TEKNISI' : 'ADMIN';
    await logTimeline(req.params.id, 'EDITED', `Detail tiket diubah oleh ${req.user.nama}`, actorType, req.user.id);

    return res.json({ success: true, message: 'Tiket berhasil diupdate' });
  } catch (e) {
    console.error('[TIKET update]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ═══════════════════════════════════════════════════
   POST /api/tiket/:id/assign — admin assign (tambah) teknisi ke tiket.
   body: { teknisi_ids: [1,2] }
═══════════════════════════════════════════════════ */
router.post('/:id/assign', requireAdmin, async (req, res) => {
  const { teknisi_ids } = req.body;
  const teknisiList = Array.isArray(teknisi_ids) ? teknisi_ids.filter(Boolean) : [];
  if (!teknisiList.length) {
    return res.status(400).json({ success: false, message: 'teknisi_ids wajib diisi minimal 1' });
  }
  try {
    const [[tiket]] = await pool.query(`SELECT tiket_no, status FROM pt_kapuk_tiket WHERE id = ?`, [req.params.id]);
    if (!tiket) return res.status(404).json({ success: false, message: 'Tiket tidak ditemukan' });
    if (['DONE', 'CANCELLED'].includes(tiket.status)) {
      return res.status(409).json({ success: false, message: 'Tiket sudah selesai/dibatalkan, tidak bisa di-assign lagi' });
    }

    for (const teknisiId of teknisiList) {
      await pool.query(
        `INSERT IGNORE INTO pt_kapuk_tiket_teknisi (tiket_id, teknisi_id, assigned_by_admin_id) VALUES (?, ?, ?)`,
        [req.params.id, teknisiId, req.user.id],
      );
    }
    if (tiket.status === 'NEW') {
      await pool.query(`UPDATE pt_kapuk_tiket SET status = 'ASSIGNED' WHERE id = ?`, [req.params.id]);
    }

    await logTimeline(req.params.id, 'ASSIGNED', `Di-assign ke ${teknisiList.length} teknisi oleh ${req.user.nama}`, 'ADMIN', req.user.id);
    teknisiList.forEach(tid => emitToTeknisi(tid, 'tiket-baru', { tiketId: Number(req.params.id), tiketNo: tiket.tiket_no }));

    return res.json({ success: true, message: 'Teknisi berhasil di-assign' });
  } catch (e) {
    console.error('[TIKET assign]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* DELETE /api/tiket/:id/assign/:teknisiId — admin lepas 1 teknisi dari tiket */
router.delete('/:id/assign/:teknisiId', requireAdmin, async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM pt_kapuk_tiket_teknisi WHERE tiket_id = ? AND teknisi_id = ?`,
      [req.params.id, req.params.teknisiId],
    );

    const [[sisa]] = await pool.query(
      `SELECT COUNT(*) AS n FROM pt_kapuk_tiket_teknisi WHERE tiket_id = ?`, [req.params.id],
    );
    if (sisa.n === 0) {
      await pool.query(`UPDATE pt_kapuk_tiket SET status = 'NEW' WHERE id = ? AND status = 'ASSIGNED'`, [req.params.id]);
    }

    await logTimeline(req.params.id, 'UNASSIGNED', `Teknisi dilepas dari tiket oleh ${req.user.nama}`, 'ADMIN', req.user.id);
    return res.json({ success: true, message: 'Teknisi berhasil dilepas dari tiket' });
  } catch (e) {
    console.error('[TIKET unassign]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ═══════════════════════════════════════════════════
   POST /api/tiket/:id/status
   Teknisi: boleh set IN_PROGRESS / DONE (harus salah satu yang ditugasin).
   Admin: boleh set CANCELLED kapan aja.
   body: { status, note? }
═══════════════════════════════════════════════════ */
router.post('/:id/status', async (req, res) => {
  const { status, note } = req.body;
  try {
    const [[tiket]] = await pool.query(`SELECT status FROM pt_kapuk_tiket WHERE id = ?`, [req.params.id]);
    if (!tiket) return res.status(404).json({ success: false, message: 'Tiket tidak ditemukan' });

    if (req.user.type === 'teknisi') {
      if (!['IN_PROGRESS', 'DONE'].includes(status)) {
        return res.status(400).json({ success: false, message: 'Teknisi hanya boleh set status IN_PROGRESS atau DONE' });
      }
      const [[relasi]] = await pool.query(
        `SELECT id FROM pt_kapuk_tiket_teknisi WHERE tiket_id = ? AND teknisi_id = ?`,
        [req.params.id, req.user.id],
      );
      if (!relasi) return res.status(403).json({ success: false, message: 'Tiket ini bukan tugas Anda' });
    } else if (req.user.type === 'admin') {
      if (status !== 'CANCELLED') {
        return res.status(400).json({ success: false, message: 'Admin hanya boleh membatalkan tiket (CANCELLED) lewat endpoint ini' });
      }
    }

    const selesaiAt = status === 'DONE' ? new Date() : null;
    await pool.query(
      `UPDATE pt_kapuk_tiket SET status = ?, selesai_at = COALESCE(?, selesai_at) WHERE id = ?`,
      [status, selesaiAt, req.params.id],
    );

    // begitu tiket DONE/CANCELLED, teknisi yang ngerjain otomatis balik ONLINE
    if (['DONE', 'CANCELLED'].includes(status)) {
      await pool.query(
        `UPDATE pt_kapuk_teknisi k
         JOIN pt_kapuk_tiket_teknisi tt ON tt.teknisi_id = k.id
         SET k.status = 'ONLINE'
         WHERE tt.tiket_id = ? AND k.status = 'ON_TASK'`,
        [req.params.id],
      );
    } else if (status === 'IN_PROGRESS') {
      await pool.query(
        `UPDATE pt_kapuk_teknisi k
         JOIN pt_kapuk_tiket_teknisi tt ON tt.teknisi_id = k.id
         SET k.status = 'ON_TASK'
         WHERE tt.tiket_id = ?`,
        [req.params.id],
      );
    }

    const actorType = req.user.type === 'teknisi' ? 'TEKNISI' : 'ADMIN';
    await logTimeline(req.params.id, status, note || `Status diubah ke ${status} oleh ${req.user.nama}`, actorType, req.user.id);
    emitToDashboard('teknisi-status-bulk-refresh', { tiketId: Number(req.params.id) });

    return res.json({ success: true, message: `Status tiket diubah ke ${status}` });
  } catch (e) {
    console.error('[TIKET status]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ═══════════════════════════════════════════════════
   POST /api/tiket/:id/files — upload foto bukti (admin atau teknisi
   yang di-assign). multipart/form-data, field "files" (maks 10).
═══════════════════════════════════════════════════ */
router.post('/:id/files', handleUploadMultiple('files', 10), async (req, res) => {
  try {
    if (req.user.type === 'teknisi') {
      const [[relasi]] = await pool.query(
        `SELECT id FROM pt_kapuk_tiket_teknisi WHERE tiket_id = ? AND teknisi_id = ?`,
        [req.params.id, req.user.id],
      );
      if (!relasi) return res.status(403).json({ success: false, message: 'Tiket ini bukan tugas Anda' });
    }

    const judul = req.body.judul || null;
    const inserted = [];
    for (const file of req.files || []) {
      const url = `/uploads/bukti/${file.filename}`;
      const [result] = await pool.query(
        `INSERT INTO pt_kapuk_tiket_files (tiket_id, judul, file_url, uploaded_by_admin_id, uploaded_by_teknisi_id)
         VALUES (?, ?, ?, ?, ?)`,
        [
          req.params.id, judul, url,
          req.user.type === 'admin' ? req.user.id : null,
          req.user.type === 'teknisi' ? req.user.id : null,
        ],
      );
      inserted.push({ id: result.insertId, url });
    }

    const actorType = req.user.type === 'teknisi' ? 'TEKNISI' : 'ADMIN';
    await logTimeline(req.params.id, 'FILE_UPLOADED', `${inserted.length} file diunggah oleh ${req.user.nama}`, actorType, req.user.id);

    return res.json({ success: true, files: inserted });
  } catch (e) {
    console.error('[TIKET files]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
