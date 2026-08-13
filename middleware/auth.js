const jwt = require('jsonwebtoken');
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET || 'pt-gokak-indonesia-dev-secret-CHANGE-ME';

/**
 * Role-based access control di sisi server. Tiap request ke endpoint
 * yang butuh login wajib bawa JWT token dari hasil login, dan endpoint
 * sensitif ngecek tipe akunnya (admin/teknisi).
 *
 *   router.post('/', requireAdmin, async (req,res)=>{...})
 *   req.user = { id, username, nama, role, type: 'admin' }  ATAU
 *   req.user = { id, username, nama, type: 'teknisi' }
 */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ success: false, message: 'Token tidak ditemukan, silakan login ulang' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    return next();
  } catch (e) {
    return res.status(401).json({ success: false, message: 'Sesi habis / token tidak valid, silakan login ulang' });
  }
}

/** Harus dipasang SETELAH requireAuth. Lolos kalau akun yang login tipe admin. */
function requireAdmin(req, res, next) {
  if (!req.user || req.user.type !== 'admin') {
    return res.status(403).json({ success: false, message: 'Aksi ini hanya untuk akun admin' });
  }
  return next();
}

/** Khusus endpoint yang boleh diakses teknisi (portal karyawan) */
function requireTeknisi(req, res, next) {
  if (!req.user || req.user.type !== 'teknisi') {
    return res.status(403).json({ success: false, message: 'Aksi ini hanya untuk akun teknisi' });
  }
  return next();
}

function signAdminToken(admin) {
  return jwt.sign(
    { id: admin.id, username: admin.username, nama: admin.nama, role: admin.role, type: 'admin' },
    JWT_SECRET,
    { expiresIn: '12h' },
  );
}

function signTeknisiToken(teknisi) {
  return jwt.sign(
    { id: teknisi.id, username: teknisi.username, nama: teknisi.nama, type: 'teknisi' },
    JWT_SECRET,
    { expiresIn: '12h' },
  );
}

module.exports = { requireAuth, requireAdmin, requireTeknisi, signAdminToken, signTeknisiToken, JWT_SECRET };
