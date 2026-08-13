const express = require('express');
const pool = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireAdmin);

/* Cache in-memory buat area PRIMARY (dipakai tiap ping GPS masuk --
 * lihat teknisi.route.js -- jadi jangan query DB tiap ping kalau lagi
 * ratusan/ribuan karyawan ngirim lokasi tiap 2 detik, itungannya bisa
 * ratusan query/detik ke DB kalau gak di-cache). TTL pendek cukup
 * karena admin gak gambar ulang poligon tiap detik. */
const CACHE_TTL_MS = 30000;
let cache = { data: null, ts: 0 };

function parsePolygon(raw) {
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

async function getPrimaryAreasCached() {
  if (cache.data && Date.now() - cache.ts < CACHE_TTL_MS) return cache.data;
  const [rows] = await pool.query(
    `SELECT id, polygon FROM pt_kapuk_area WHERE is_primary = 1 AND is_active = 1`,
  );
  cache.data = rows.map(r => ({ id: r.id, polygon: parsePolygon(r.polygon) }));
  cache.ts = Date.now();
  return cache.data;
}

function invalidateAreaCache() { cache.ts = 0; }

/* GET /api/area — semua area (admin lihat & kelola, termasuk yang non-aktif) */
router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, ad.nama AS created_by_nama FROM pt_kapuk_area a
       JOIN pt_kapuk_admins ad ON ad.id = a.created_by
       ORDER BY a.is_primary DESC, a.created_at ASC`,
    );
    const area = rows.map(r => ({ ...r, polygon: parsePolygon(r.polygon) }));
    return res.json({ success: true, area });
  } catch (e) {
    console.error('[AREA list]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* POST /api/area — bikin area baru.
   body: { nama, deskripsi?, is_primary?, height?, color?, polygon: [[lng,lat],...] } */
router.post('/', async (req, res) => {
  const { nama, deskripsi, is_primary, height, color, polygon } = req.body;
  if (!nama || !Array.isArray(polygon) || polygon.length < 3) {
    return res.status(400).json({ success: false, message: 'nama & polygon (minimal 3 titik) wajib diisi' });
  }
  try {
    const [result] = await pool.query(
      `INSERT INTO pt_kapuk_area (nama, deskripsi, is_primary, height, color, polygon, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        nama, deskripsi || null, is_primary ? 1 : 0, height || 10, color || '#f59e0b',
        JSON.stringify(polygon), req.user.id,
      ],
    );
    invalidateAreaCache();
    return res.json({ success: true, areaId: result.insertId });
  } catch (e) {
    console.error('[AREA create]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* PUT /api/area/:id — edit nama/deskripsi/is_primary/height/color/polygon/is_active */
router.put('/:id', async (req, res) => {
  const { nama, deskripsi, is_primary, height, color, polygon, is_active } = req.body;
  if (!nama || !Array.isArray(polygon) || polygon.length < 3) {
    return res.status(400).json({ success: false, message: 'nama & polygon (minimal 3 titik) wajib diisi' });
  }
  try {
    await pool.query(
      `UPDATE pt_kapuk_area SET nama=?, deskripsi=?, is_primary=?, height=?, color=?, polygon=?, is_active=?
       WHERE id = ?`,
      [
        nama, deskripsi || null, is_primary ? 1 : 0, height || 10, color || '#f59e0b',
        JSON.stringify(polygon), is_active === undefined ? 1 : (is_active ? 1 : 0), req.params.id,
      ],
    );
    invalidateAreaCache();
    return res.json({ success: true, message: 'Area berhasil diupdate' });
  } catch (e) {
    console.error('[AREA update]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* DELETE /api/area/:id — hapus permanen (histori kehadiran tetap aman,
   area_id di pt_kapuk_teknisi_lokasi otomatis jadi NULL lewat FK). */
router.delete('/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM pt_kapuk_area WHERE id = ?`, [req.params.id]);
    invalidateAreaCache();
    return res.json({ success: true, message: 'Area berhasil dihapus' });
  } catch (e) {
    console.error('[AREA delete]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
module.exports.getPrimaryAreasCached = getPrimaryAreasCached;
module.exports.invalidateAreaCache = invalidateAreaCache;
