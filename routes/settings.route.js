const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Public route to get app_name
router.get('/public', async (req, res) => {
    try {
        const [rows] = await req.db.query('SELECT setting_value FROM pt_gokak_settings WHERE setting_key = "app_name"');
        const appName = rows.length > 0 ? rows[0].setting_value : 'CMMS Gokak';
        res.json({ success: true, app_name: appName });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, error: 'Database error' });
    }
});

// Admin-only middleware check
router.use((req, res, next) => {
    if (!req.user || req.user.role !== 'ADMIN') {
        return res.status(403).json({ success: false, error: 'Unauthorized' });
    }
    next();
});

// Update app name
router.post('/app-name', async (req, res) => {
    try {
        const { app_name } = req.body;
        if (!app_name) return res.status(400).json({ success: false, error: 'Nama aplikasi diperlukan' });
        
        await req.db.query(
            'INSERT INTO pt_gokak_settings (setting_key, setting_value) VALUES ("app_name", ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)', 
            [app_name]
        );
        res.json({ success: true, message: 'Nama sistem berhasil diperbarui' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, error: 'Database error' });
    }
});

// Upload logo using multer
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, path.join(__dirname, '../public/libraries/assets/images'));
    },
    filename: (req, file, cb) => {
        cb(null, 'logo.png'); // Always overwrite the logo.png
    }
});

const upload = multer({
    storage: storage,
    fileFilter: (req, file, cb) => {
        const filetypes = /jpeg|jpg|png/;
        const mimetype = filetypes.test(file.mimetype);
        const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
        if (mimetype && extname) {
            return cb(null, true);
        }
        cb(new Error("Hanya file gambar (JPG/PNG) yang diperbolehkan!"));
    }
});

router.post('/logo', (req, res) => {
    const uploadSingle = upload.single('logoFile');
    uploadSingle(req, res, function (err) {
        if (err instanceof multer.MulterError) {
            return res.status(400).json({ success: false, error: err.message });
        } else if (err) {
            return res.status(400).json({ success: false, error: err.message });
        }
        
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'File logo tidak ditemukan' });
        }

        // Return a cache buster timestamp so frontend can force reload image
        res.json({ success: true, message: 'Logo berhasil diperbarui', timestamp: Date.now() });
    });
});

module.exports = router;
