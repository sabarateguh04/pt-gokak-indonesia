const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

// Public route to get app settings (no auth required — used by login page)
router.get('/public', async (req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT setting_key, setting_value FROM pt_gokak_settings WHERE setting_key IN ("app_name", "logo_version")'
        );
        const map = {};
        rows.forEach(r => { map[r.setting_key] = r.setting_value; });
        const appName = map['app_name'] || 'CMMS Gokak';
        // Add cache-buster to logo URL so browsers reload latest logo
        const logoVersion = map['logo_version'] || '1';
        const logoUrl = `/libraries/assets/images/logo.png?v=${logoVersion}`;
        res.json({ success: true, app_name: appName, logo_url: logoUrl });
    } catch (e) {
        console.error('[SETTINGS public]', e.message);
        res.status(500).json({ success: false, error: 'Database error' });
    }
});

// Admin-only middleware check
router.use(requireAuth, (req, res, next) => {
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
        await pool.query(
            'INSERT INTO pt_gokak_settings (setting_key, setting_value) VALUES ("app_name", ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
            [app_name]
        );
        res.json({ success: true, message: 'Nama sistem berhasil diperbarui' });
    } catch (e) {
        console.error('[SETTINGS app-name]', e.message);
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
    uploadSingle(req, res, async function (err) {
        if (err instanceof multer.MulterError) {
            return res.status(400).json({ success: false, error: err.message });
        } else if (err) {
            return res.status(400).json({ success: false, error: err.message });
        }
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'File logo tidak ditemukan' });
        }
        // Save version timestamp so /public API returns cache-busted URL
        const version = String(Date.now());
        try {
            await pool.query(
                'INSERT INTO pt_gokak_settings (setting_key, setting_value) VALUES ("logo_version", ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
                [version]
            );
        } catch (e) {
            console.error('[SETTINGS logo version]', e.message);
        }
        res.json({ success: true, message: 'Logo berhasil diperbarui', logo_url: `/libraries/assets/images/logo.png?v=${version}` });
    });
});

module.exports = router;
