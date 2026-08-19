const express = require('express');
const pool = require('../db');
const { emitToDashboard, emitToTeknisi } = require('../socket'); // might need to rename emitToTeknisi later, but keep for now
const { requireAuth } = require('../middleware/auth');
const { handleUploadMultiple } = require('../middleware/upload');

const router = express.Router();
router.use(requireAuth);

/* Helper: generate nomor task harian, format TSK-YYYYMMDD-XXX */
async function generateTaskNo() {
  const today = new Date();
  const ymd = today.toISOString().slice(0, 10).replace(/-/g, '');
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS n FROM pt_gokak_tasks WHERE task_no LIKE ?`,
    [`TSK-${ymd}-%`],
  );
  const seq = String(row.n + 1).padStart(3, '0');
  return `TSK-${ymd}-${seq}`;
}

/* Helper: tulis timeline */
async function logTimeline(taskId, eventType, note, actorId = null) {
  await pool.query(
    `INSERT INTO pt_gokak_task_timeline (task_id, event_type, note, actor_id) VALUES (?, ?, ?, ?)`,
    [taskId, eventType, note || null, actorId],
  );

  emitToDashboard('task-update', { taskId: Number(taskId), eventType });
  try {
    const [[task]] = await pool.query(`SELECT assigned_to_id FROM pt_gokak_tasks WHERE id = ?`, [taskId]);
    if (task && task.assigned_to_id) {
      emitToTeknisi(task.assigned_to_id, 'task-update', { taskId: Number(taskId), eventType });
    }
  } catch (e) {
    console.error('[NOTIF task-update]', e.message);
  }
}

/* Helper: ambil detail */
async function getTaskDetail(taskId) {
  const [rows] = await pool.query(
    `SELECT t.*,
            l.nama AS line_nama,
            m.nama AS machine_nama,
            c.nama AS category_nama,
            cb.nama AS created_by_nama, cb.role AS created_by_role,
            ab.nama AS assigned_to_nama,
            vb.nama AS verified_by_nama,
            p.checklist_json AS pm_checklist
     FROM pt_gokak_tasks t
     LEFT JOIN pt_gokak_lines l ON l.id = t.line_id
     LEFT JOIN pt_gokak_machines m ON m.id = t.machine_id
     LEFT JOIN pt_gokak_task_categories c ON c.id = t.category_id
     LEFT JOIN pt_gokak_users cb ON cb.id = t.created_by_id
     LEFT JOIN pt_gokak_users ab ON ab.id = t.assigned_to_id
     LEFT JOIN pt_gokak_users vb ON vb.id = t.verified_by_id
     LEFT JOIN pt_gokak_pm_parameters p ON m.tipe = p.machine_tipe
     WHERE t.id = ?`,
    [taskId],
  );
  if (rows.length === 0) return null;
  const task = rows[0];

  const [timeline] = await pool.query(
    `SELECT tl.*, u.nama as actor_nama, u.role as actor_role 
     FROM pt_gokak_task_timeline tl 
     LEFT JOIN pt_gokak_users u ON u.id = tl.actor_id 
     WHERE tl.task_id = ? ORDER BY tl.created_at DESC`, [taskId]
  );

  const [files] = await pool.query(
    `SELECT f.*, u.nama as uploader_nama 
     FROM pt_gokak_task_files f 
     LEFT JOIN pt_gokak_users u ON u.id = f.uploaded_by_id 
     WHERE f.task_id = ? ORDER BY f.created_at DESC`, [taskId]
  );

  return { ...task, timeline, files };
}

/* ═══════════════════════════════════════════════════
   GET /api/tasks/form-data
   Ambil master data (lines, machines, categories) untuk form Lapor Kendala
═══════════════════════════════════════════════════ */
router.get('/form-data', async (req, res) => {
  try {
    const [categories] = await pool.query('SELECT id, nama FROM pt_gokak_task_categories ORDER BY nama ASC');
    const [machines] = await pool.query('SELECT id, nama, line_id FROM pt_gokak_machines WHERE is_active = 1 ORDER BY nama ASC');
    const [lines] = await pool.query('SELECT id, nama FROM pt_gokak_lines WHERE is_active = 1 ORDER BY nama ASC');
    return res.json({ success: true, data: { categories, machines, lines } });
  } catch (e) {
    console.error('[TASK form-data]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ═══════════════════════════════════════════════════
   GET /api/tasks
   ADMIN/EXECUTIVE: lihat semua. 
   LEADER: lihat line miliknya.
   MEKANIK: lihat yang di-assign ke dia atau dia buat.
═══════════════════════════════════════════════════ */
router.get('/', async (req, res) => {
  try {
    let sql = `
      SELECT t.id, t.task_no, t.judul, t.priority, t.status,
             t.line_id, l.nama AS line_nama, 
             t.machine_id, m.nama AS machine_nama,
             c.nama AS category_nama,
             u.nama AS assigned_to_nama,
             t.created_at, t.updated_at
      FROM pt_gokak_tasks t
      LEFT JOIN pt_gokak_lines l ON l.id = t.line_id
      LEFT JOIN pt_gokak_machines m ON m.id = t.machine_id
      LEFT JOIN pt_gokak_task_categories c ON c.id = t.category_id
      LEFT JOIN pt_gokak_users u ON u.id = t.assigned_to_id
    `;
    const params = [];
    const where = [];

    // RBAC Scope
    if (req.user.role === 'LEADER') {
      where.push(`t.line_id = ?`);
      params.push(req.user.line_id);
    } else if (req.user.role === 'MEKANIK') {
      where.push(`(t.assigned_to_id = ? OR t.created_by_id = ?)`);
      params.push(req.user.id, req.user.id);
    }

    const { status, priority } = req.query;
    if (status)   { where.push(`t.status = ?`); params.push(status); }
    if (priority) { where.push(`t.priority = ?`); params.push(priority); }

    if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
    sql += ` ORDER BY t.created_at DESC`;

    const [rows] = await pool.query(sql, params);
    return res.json({ success: true, data: rows });
  } catch (e) {
    console.error('[TASK list]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* GET /api/tasks/:id */
router.get('/:id', async (req, res) => {
  try {
    const task = await getTaskDetail(req.params.id);
    if (!task) return res.status(404).json({ success: false, message: 'Task tidak ditemukan' });

    // RBAC Check
    if (req.user.role === 'LEADER' && task.line_id !== req.user.line_id) {
      return res.status(403).json({ success: false, message: 'Akses ditolak: Beda Line' });
    }
    if (req.user.role === 'MEKANIK' && task.assigned_to_id !== req.user.id && task.created_by_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Akses ditolak: Bukan tugas Anda' });
    }

    return res.json({ success: true, data: task });
  } catch (e) {
    console.error('[TASK detail]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ═══════════════════════════════════════════════════
   POST /api/tasks
   Buat task baru (Leader / Mekanik / Admin)
═══════════════════════════════════════════════════ */
router.post('/', async (req, res) => {
  if (req.user.role === 'EXECUTIVE') return res.status(403).json({ success: false, message: 'Executive read-only' });

  const { judul, deskripsi, category_id, priority, machine_id, assigned_to_id } = req.body;
  if (!judul) return res.status(400).json({ success: false, message: 'Judul wajib diisi' });

  // Tentukan line_id (Admin bebas ngisi apa aja, Leader/Mekanik otomatis pakai line_id mereka)
  let line_id = req.user.role === 'ADMIN' ? req.body.line_id : req.user.line_id;

  // Tentukan assigned_to_id (Mekanik otomatis assign ke diri sendiri)
  let finalAssignedTo = assigned_to_id || null;
  if (req.user.role === 'MEKANIK') {
    finalAssignedTo = req.user.id;
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const taskNo = await generateTaskNo();
    const status = finalAssignedTo ? 'OPEN' : 'OPEN'; // Kita buat OPEN default, bisa IN_PROGRESS nanti.

    const [result] = await conn.query(
      `INSERT INTO pt_gokak_tasks
         (task_no, judul, deskripsi, category_id, priority, line_id, machine_id, status, created_by_id, assigned_to_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        taskNo, judul, deskripsi || null, category_id || null, priority || 'MEDIUM',
        line_id || null, machine_id || null, status, req.user.id, finalAssignedTo
      ],
    );
    const taskId = result.insertId;

    await conn.commit();

    await logTimeline(taskId, 'CREATED', `Task dibuat oleh ${req.user.nama}`, req.user.id);
    if (finalAssignedTo && finalAssignedTo !== req.user.id) {
      emitToTeknisi(finalAssignedTo, 'task-baru', { taskId, taskNo, judul });
    }

    return res.json({ success: true, taskId, taskNo });
  } catch (e) {
    await conn.rollback();
    console.error('[TASK create]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    conn.release();
  }
});

/* ═══════════════════════════════════════════════════
   PUT /api/tasks/:id
   Edit task (judul, deskripsi, category, priority, etc)
═══════════════════════════════════════════════════ */
router.put('/:id', async (req, res) => {
  if (req.user.role === 'EXECUTIVE') return res.status(403).json({ success: false, message: 'Executive read-only' });

  const { judul, deskripsi, category_id, priority, line_id, machine_id, assigned_to_id } = req.body;
  
  const conn = await pool.getConnection();
  try {
    const [[task]] = await conn.query(`SELECT status, line_id, created_by_id FROM pt_gokak_tasks WHERE id = ?`, [req.params.id]);
    if (!task) return res.status(404).json({ success: false, message: 'Task tidak ditemukan' });
    if (['SELESAI', 'TERVERIFIKASI', 'CANCELLED'].includes(task.status)) {
      return res.status(400).json({ success: false, message: 'Task sudah selesai/dibatalkan, tidak bisa diedit' });
    }

    if (req.user.role === 'MEKANIK' && task.created_by_id !== req.user.id) {
        return res.status(403).json({ success: false, message: 'Anda hanya bisa mengedit task yang Anda buat sendiri' });
    }

    let finalLineId = line_id || null;
    if (req.user.role === 'LEADER') finalLineId = req.user.line_id; // paksa line_id leader

    await conn.query(
      `UPDATE pt_gokak_tasks
       SET judul=?, deskripsi=?, category_id=?, priority=?, line_id=?, machine_id=?, assigned_to_id=?
       WHERE id=?`,
      [
        judul, deskripsi || null, category_id || null, priority || 'MEDIUM',
        finalLineId, machine_id || null, assigned_to_id || null, req.params.id
      ]
    );

    await logTimeline(req.params.id, 'UPDATED', `Task diperbarui oleh ${req.user.nama}`, req.user.id);
    return res.json({ success: true, message: 'Task berhasil diperbarui' });
  } catch (e) {
    console.error('[TASK update]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    conn.release();
  }
});

/* ═══════════════════════════════════════════════════
   POST /api/tasks/:id/status
   Mekanik: ubah ke IN_PROGRESS / SELESAI.
   Admin/Leader: CANCELLED.
═══════════════════════════════════════════════════ */
router.post('/:id/status', async (req, res) => {
  const { status, note } = req.body;
  try {
    const [[task]] = await pool.query(`SELECT status, assigned_to_id, line_id FROM pt_gokak_tasks WHERE id = ?`, [req.params.id]);
    if (!task) return res.status(404).json({ success: false, message: 'Task tidak ditemukan' });

    // RBAC
    if (req.user.role === 'EXECUTIVE') return res.status(403).json({ success: false, message: 'Read-only' });
    if (req.user.role === 'MEKANIK') {
      if (task.assigned_to_id !== req.user.id) return res.status(403).json({ success: false, message: 'Bukan tugas Anda' });
      if (!['IN_PROGRESS', 'SELESAI'].includes(status)) return res.status(400).json({ success: false, message: 'Mekanik hanya IN_PROGRESS / SELESAI' });
    }
    if (req.user.role === 'LEADER') {
      if (task.line_id !== req.user.line_id) return res.status(403).json({ success: false, message: 'Bukan line Anda' });
      if (status !== 'CANCELLED') return res.status(400).json({ success: false, message: 'Leader dari sini hanya bisa cancel (verifikasi ada rute terpisah)' });
    }

    const selesaiAt = status === 'SELESAI' ? new Date() : null;
    await pool.query(
      `UPDATE pt_gokak_tasks SET status = ?, selesai_at = COALESCE(?, selesai_at), pm_checklist_result = COALESCE(?, pm_checklist_result) WHERE id = ?`,
      [status, selesaiAt, req.body.pm_checklist_result ? JSON.stringify(req.body.pm_checklist_result) : null, req.params.id],
    );

    // Update status online Mekanik jika selesai
    if (task.assigned_to_id) {
      if (['SELESAI', 'CANCELLED'].includes(status)) {
        await pool.query(`UPDATE pt_gokak_users SET status = 'ONLINE' WHERE id = ? AND status = 'ON_TASK'`, [task.assigned_to_id]);
      } else if (status === 'IN_PROGRESS') {
        await pool.query(`UPDATE pt_gokak_users SET status = 'ON_TASK' WHERE id = ?`, [task.assigned_to_id]);
      }
    }

    await logTimeline(req.params.id, status, note || `Status diubah ke ${status} oleh ${req.user.nama}`, req.user.id);
    emitToDashboard('task-status-bulk-refresh', { taskId: Number(req.params.id) });

    return res.json({ success: true, message: `Status diubah ke ${status}` });
  } catch (e) {
    console.error('[TASK status]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ═══════════════════════════════════════════════════
   POST /api/tasks/:id/verify
   Leader: Verifikasi pekerjaan yang sudah SELESAI.
═══════════════════════════════════════════════════ */
router.post('/:id/verify', async (req, res) => {
  const { note } = req.body;
  try {
    if (req.user.role !== 'LEADER' && req.user.role !== 'ADMIN') {
      return res.status(403).json({ success: false, message: 'Hanya Leader/Admin yang bisa memverifikasi' });
    }

    const [[task]] = await pool.query(`SELECT status, line_id, category_id, machine_id FROM pt_gokak_tasks WHERE id = ?`, [req.params.id]);
    if (!task) return res.status(404).json({ success: false, message: 'Task tidak ditemukan' });
    if (task.status !== 'SELESAI') return res.status(400).json({ success: false, message: 'Task belum SELESAI' });
    if (req.user.role === 'LEADER' && task.line_id !== req.user.line_id) return res.status(403).json({ success: false, message: 'Bukan line Anda' });

    await pool.query(
      `UPDATE pt_gokak_tasks SET status = 'TERVERIFIKASI', verified_by_id = ?, verified_at = NOW() WHERE id = ?`,
      [req.user.id, req.params.id],
    );

    // Jika ini adalah tugas Preventive Maintenance (kategori 2), update last_pm_at di mesin
    if (task.category_id === 2 && task.machine_id) {
      await pool.query(
        `UPDATE pt_gokak_machines SET last_pm_at = CURDATE() WHERE id = ?`,
        [task.machine_id]
      );
    }

    await logTimeline(req.params.id, 'TERVERIFIKASI', note || `Diverifikasi oleh ${req.user.nama}`, req.user.id);
    
    return res.json({ success: true, message: 'Task berhasil diverifikasi' });
  } catch (e) {
    console.error('[TASK verify]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ═══════════════════════════════════════════════════
   POST /api/tasks/:id/files — Upload bukti
═══════════════════════════════════════════════════ */
router.post('/:id/files', handleUploadMultiple('files', 10), async (req, res) => {
  try {
    const judul = req.body.judul || null;
    const inserted = [];
    for (const file of req.files || []) {
      const url = `/uploads/bukti/${file.filename}`;
      const [result] = await pool.query(
        `INSERT INTO pt_gokak_task_files (task_id, judul, file_url, uploaded_by_id) VALUES (?, ?, ?, ?)`,
        [req.params.id, judul, url, req.user.id],
      );
      inserted.push({ id: result.insertId, url });
    }

    await logTimeline(req.params.id, 'FILE_UPLOADED', `${inserted.length} file diunggah oleh ${req.user.nama}`, req.user.id);

    return res.json({ success: true, files: inserted });
  } catch (e) {
    console.error('[TASK files]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
