const jwt = require('jsonwebtoken');
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET || 'pt-gokak-indonesia-dev-secret-CHANGE-ME';

/**
 * Middleware dasar: wajib punya token valid.
 * Hasilnya `req.user` akan berisi payload: { id, username, nama, role, line_id }
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

/**
 * Factory middleware untuk Role-Based Access Control (RBAC).
 * Contoh: `router.post('/', requireAuth, requireRoles('ADMIN', 'LEADER'), ...)`
 */
function requireRoles(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ 
        success: false, 
        message: `Akses ditolak. Dibutuhkan salah satu role: ${allowedRoles.join(', ')}` 
      });
    }
    return next();
  };
}

/** Shortcut untuk role spesifik */
const requireAdmin = requireRoles('ADMIN');
const requireLeader = requireRoles('LEADER');
const requireMekanik = requireRoles('MEKANIK');
const requireExecutive = requireRoles('EXECUTIVE');

function signUserToken(user) {
  return jwt.sign(
    { 
      id: user.id, 
      username: user.username, 
      nama: user.nama, 
      role: user.role, 
      line_id: user.line_id 
    },
    JWT_SECRET,
    { expiresIn: '12h' },
  );
}

module.exports = { 
  requireAuth, 
  requireRoles,
  requireAdmin, 
  requireLeader,
  requireMekanik,
  requireExecutive,
  signUserToken, 
  JWT_SECRET 
};
