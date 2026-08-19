const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

// Middleware untuk restrict to Admin
function requireAdmin(req, res, next) {
  if (req.user.role !== 'ADMIN') {
    return res.status(403).json({ success: false, message: 'Khusus Admin' });
  }
  next();
}

// ---------------------------------------------------------
// 1. PARAMETERS CRUD (Khusus Admin)
// ---------------------------------------------------------
router.get('/parameters', async (req, res) => {
  try {
    const [rows] = await db.query(`SELECT * FROM pt_gokak_pm_parameters ORDER BY created_at DESC`);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/parameters', requireAdmin, async (req, res) => {
  try {
    const { id, machine_tipe, cycle_days, checklist_json } = req.body;
    if (!machine_tipe || !cycle_days) {
      return res.status(400).json({ success: false, message: 'Tipe mesin dan siklus wajib diisi' });
    }

    const cJSON = typeof checklist_json === 'string' ? checklist_json : JSON.stringify(checklist_json || []);

    if (id) {
      await db.query(
        `UPDATE pt_gokak_pm_parameters SET machine_tipe=?, cycle_days=?, checklist_json=? WHERE id=?`,
        [machine_tipe, cycle_days, cJSON, id]
      );
    } else {
      await db.query(
        `INSERT INTO pt_gokak_pm_parameters (machine_tipe, cycle_days, checklist_json) VALUES (?, ?, ?)`,
        [machine_tipe, cycle_days, cJSON]
      );
    }
    res.json({ success: true, message: 'Parameter PM disimpan' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.delete('/parameters/:id', requireAdmin, async (req, res) => {
  try {
    await db.query(`DELETE FROM pt_gokak_pm_parameters WHERE id=?`, [req.params.id]);
    res.json({ success: true, message: 'Dihapus' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ---------------------------------------------------------
// 2. SCHEDULES (Jadwal PM Mesin)
// ---------------------------------------------------------
router.get('/schedules', async (req, res) => {
  try {
    // Leader hanya melihat line miliknya
    let whereClause = "m.is_active = 1";
    let params = [];
    if (req.user.role === 'LEADER') {
      whereClause += " AND m.line_id = ?";
      params.push(req.user.line_id);
    }

    // Join mesin dengan pm_parameters berdasarkan tipe
    const query = `
      SELECT 
        m.id as machine_id, m.kode, m.nama as machine_name, m.tipe, m.last_pm_at,
        p.id as param_id, p.cycle_days, p.checklist_json,
        l.nama as line_name
      FROM pt_gokak_machines m
      LEFT JOIN pt_gokak_pm_parameters p ON m.tipe = p.machine_tipe
      LEFT JOIN pt_gokak_lines l ON m.line_id = l.id
      WHERE ${whereClause}
      ORDER BY l.nama ASC, m.kode ASC
    `;
    const [machines] = await db.query(query, params);

    // Hitung status jatuh tempo per mesin
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const schedules = machines.map(m => {
      // Jika tipe mesin ini belum ada parameternya
      if (!m.cycle_days) {
        return { ...m, status: 'NO_PARAMETER', days_remaining: null };
      }
      
      let nextPmDate;
      if (!m.last_pm_at) {
        // Belum pernah di PM, anggap segera jatuh tempo
        nextPmDate = today;
      } else {
        nextPmDate = new Date(m.last_pm_at);
        nextPmDate.setDate(nextPmDate.getDate() + m.cycle_days);
      }

      const diffTime = nextPmDate.getTime() - today.getTime();
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

      let status = 'OK';
      if (diffDays <= 0) status = 'DUE';
      else if (diffDays <= 3) status = 'WARNING'; // H-3

      return {
        ...m,
        next_pm_at: nextPmDate.toISOString().split('T')[0],
        days_remaining: diffDays,
        status
      };
    });

    res.json({ success: true, data: schedules });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ---------------------------------------------------------
// 3. GENERATE TASKS
// ---------------------------------------------------------
router.post('/generate-tasks', async (req, res) => {
  try {
    // Memerlukan role ADMIN atau LEADER
    if (!['ADMIN', 'LEADER'].includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Akses ditolak' });
    }

    const { machine_id } = req.body;
    if (!machine_id) return res.status(400).json({ success: false, message: 'machine_id wajib diisi' });

    // Dapatkan data mesin dan parameter
    const [machines] = await db.query(`
      SELECT m.*, p.id as param_id, p.checklist_json 
      FROM pt_gokak_machines m
      JOIN pt_gokak_pm_parameters p ON m.tipe = p.machine_tipe
      WHERE m.id = ?
    `, [machine_id]);

    if (machines.length === 0) {
      return res.status(404).json({ success: false, message: 'Mesin atau parameter PM tidak ditemukan' });
    }
    const m = machines[0];

    // Cek apakah mesin ini sedang ada task PM yang belum selesai
    const [activeTasks] = await db.query(`
      SELECT id FROM pt_gokak_tasks 
      WHERE machine_id = ? AND category_id = 2 AND status NOT IN ('TERVERIFIKASI', 'CANCELLED')
    `, [machine_id]);

    if (activeTasks.length > 0) {
      return res.status(400).json({ success: false, message: 'Tugas PM untuk mesin ini sudah ada dan belum diverifikasi' });
    }

    // Buat tugas baru
    const prefix = 'PM-' + new Date().toISOString().slice(2,10).replace(/-/g, '') + '-';
    const [numRes] = await db.query(`SELECT COUNT(*) as c FROM pt_gokak_tasks WHERE DATE(created_at) = CURDATE()`);
    const taskNo = prefix + String(numRes[0].c + 1).padStart(3, '0');

    // category_id = 2 (Preventive Maintenance) -> diasumsikan 2 berdasarkan seeder
    const qInsert = `
      INSERT INTO pt_gokak_tasks 
      (task_no, judul, deskripsi, category_id, priority, line_id, machine_id, created_by_id, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN')
    `;
    const title = `Preventive Maintenance: ${m.nama} (${m.kode})`;
    const desc = `Jadwal PM otomatis. Harap isi checklist PM saat menyelesaikan tugas.`;
    
    const [ins] = await db.query(qInsert, [
      taskNo, title, desc, 2, 'HIGH', m.line_id, m.id, req.user.id
    ]);
    const taskId = ins.insertId;

    // Timeline event
    await db.query(`INSERT INTO pt_gokak_task_timeline (task_id, event_type, note, actor_id) VALUES (?, ?, ?, ?)`,
      [taskId, 'CREATED', 'Tugas PM dibuat (otomatis generate jadwal)', req.user.id]
    );

    res.json({ success: true, message: 'Tugas PM berhasil dibuat!', task_id: taskId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
