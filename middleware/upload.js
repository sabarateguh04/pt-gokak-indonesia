const fs = require('fs');
const path = require('path');
const multer = require('multer');

/* Foto bukti pengerjaan tiket disimpan di:
     <project-root>/uploads/bukti/
   dan diakses publik lewat: http://<host>/uploads/bukti/<namafile>
   (di-serve statis lewat express.static di server.js) */
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'bukti');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    const safeBase = path
      .basename(file.originalname, ext)
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 40);
    cb(null, `${Date.now()}-${safeBase}${ext}`);
  },
});

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

const uploadBukti = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME.includes(file.mimetype)) {
      return cb(new Error('Format file harus JPG, PNG, WEBP, atau PDF'));
    }
    cb(null, true);
  },
});

/** Bungkus multer supaya errornya (ukuran kegedean, format salah, dll)
 *  balik sebagai JSON rapi, bukan crash / HTML error Express default. */
function handleUploadMultiple(fieldName, maxCount = 10) {
  return (req, res, next) => {
    uploadBukti.array(fieldName, maxCount)(req, res, (err) => {
      if (err) return res.status(400).json({ success: false, message: err.message });
      next();
    });
  };
}

module.exports = { uploadBukti, handleUploadMultiple };
