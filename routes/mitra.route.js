/* ⚠️ VENDOR-ONLY — menu "Kelola Mitra" di dashboard. Cuma kedaftar di
 * server.js kalau env VENDOR_MASTER_MODE=true, DAN file ini SENGAJA
 * dikecualikan dari build customer (lihat scripts/build-obfuscate.js)
 * -- jadi walaupun ada yang salah-set VENDOR_MASTER_MODE=true di
 * instalasi customer, file ini gak akan ADA sama sekali di sana,
 * require()-nya bakal gagal & di-tangkep try/catch di server.js.
 *
 * Fungsinya: bungkus lib/issue-license.js (yang sama dipakai CLI
 * register-partner.js & generate-license.js) jadi API, dipanggil dari
 * public/admin/mitra.html. Satu form "Tambah Mitra Baru" langsung:
 *   1. Daftarin id_mitra ke registry lokal (licensing-tools/partners.json)
 *   2. Generate token lisensi (JWT RS256, private key TETAP di laptop ini)
 *   3. Scaffold folder docker/<id_mitra>/ isinya paket lengkap siap kirim
 */
const express = require('express');
const lib = require('../licensing-tools/lib/issue-license');

const router = express.Router();

/* GET /api/mitra -- daftar semua mitra terdaftar (buat tabel di UI) */
router.get('/', (req, res) => {
  const registry = lib.loadRegistry();
  const list = Object.entries(registry).map(([id, p]) => ({ id, ...p }));
  list.sort((a, b) => new Date(b.registered_at) - new Date(a.registered_at));
  return res.json({ success: true, mitra: list });
});

/* ═══════════════════════════════════════════════════
   POST /api/mitra
   body: { nama, id? (auto-slug dari nama kalau kosong), base_seats,
           addon_seats, years, note }
   Sekali submit -> terdaftar + token jadi + folder docker/<id>/ jadi.
═══════════════════════════════════════════════════ */
router.post('/', (req, res) => {
  const { nama, id, base_seats, addon_seats, years, note } = req.body;
  if (!nama || !base_seats || !years) {
    return res.status(400).json({ success: false, message: 'nama, base_seats, dan years wajib diisi.' });
  }

  const idMitra = (id && id.trim()) ? lib.slugify(id) : lib.slugify(nama);

  try {
    const existing = lib.loadRegistry()[idMitra];
    if (existing) {
      return res.status(409).json({ success: false, message: `id_mitra '${idMitra}' sudah dipakai mitra lain ('${existing.name}'). Isi kolom ID manual yang beda kalau memang mitra baru.` });
    }

    lib.registerOrUpdatePartner({ id: idMitra, name: nama, note: note || null });
    const { token, decoded } = lib.generateLicenseToken({
      id: idMitra, customer: nama, base: base_seats, addon: addon_seats || 0, years,
    });
    const folder = lib.scaffoldDockerPackage({ id: idMitra, customer: nama, token, decoded });

    return res.json({
      success: true,
      id: idMitra,
      folder,
      token,
      valid_until: new Date(decoded.exp * 1000),
      total_seats: (decoded.base_seats || 0) + (decoded.addon_seats || 0),
      message: `Mitra '${nama}' berhasil dibuat. Paket lengkap ada di folder ${folder} -- tinggal zip & kirim.`,
    });
  } catch (e) {
    console.error('[MITRA create]', e.message);
    return res.status(500).json({ success: false, message: e.message || 'Server error' });
  }
});

/* POST /api/mitra/:id/reissue -- generate token BARU buat mitra yang
   SUDAH ada (renewal / nambah seat / ganti masa aktif), sekalian
   nulis ulang folder docker/<id>/ (JWT_SECRET di .env TETAP dipertahankan
   biar instalasi yang UDAH JALAN gak perlu ganti JWT_SECRET-nya --
   cuma LICENSE-TOKEN.txt & README yang di-refresh). */
router.post('/:id/reissue', (req, res) => {
  const { id } = req.params;
  const { base_seats, addon_seats, years } = req.body;
  if (!base_seats || !years) {
    return res.status(400).json({ success: false, message: 'base_seats dan years wajib diisi.' });
  }

  try {
    const registry = lib.loadRegistry();
    const partner = registry[id];
    if (!partner) return res.status(404).json({ success: false, message: `id_mitra '${id}' gak ketemu.` });

    const { token, decoded } = lib.generateLicenseToken({
      id, customer: partner.name, base: base_seats, addon: addon_seats || 0, years,
    });
    const folder = lib.scaffoldDockerPackage({ id, customer: partner.name, token, decoded });

    return res.json({
      success: true,
      id,
      folder,
      token,
      valid_until: new Date(decoded.exp * 1000),
      total_seats: (decoded.base_seats || 0) + (decoded.addon_seats || 0),
      message: `Token baru buat '${partner.name}' berhasil dibuat (JWT_SECRET instalasi lama TETAP dipertahankan). Kirim ulang LICENSE-TOKEN.txt dari folder ${folder}.`,
    });
  } catch (e) {
    console.error('[MITRA reissue]', e.message);
    return res.status(500).json({ success: false, message: e.message || 'Server error' });
  }
});

/* POST /api/mitra/:id/refresh-package -- regenerate folder docker/<id>/
   pakai TOKEN YANG SUDAH ADA (gak nerbitin lisensi baru) -- buat
   kasus "ada versi baru aplikasi (v1.1, v2, dst), mitra yang UDAH
   JALAN tinggal di-update docker-compose.yml-nya" tanpa bikin seolah
   lisensinya ikut berubah. JWT_SECRET & token TETAP SAMA. */
router.post('/:id/refresh-package', (req, res) => {
  try {
    const folder = lib.refreshPackage({ id: req.params.id });
    return res.json({ success: true, id: req.params.id, folder, message: `Paket '${req.params.id}' diperbarui ke versi aplikasi terbaru (lisensi TIDAK berubah). Kirim ulang docker-compose.yml dari ${folder}.` });
  } catch (e) {
    return res.status(400).json({ success: false, message: e.message });
  }
});

/* POST /api/mitra/:id/revoke -- nonaktifkan (gak bisa generate token
   baru lagi), token yang UDAH kepasang di customer TETAP jalan sampai
   exp-nya sendiri (ini bukan "cabut lisensi jarak jauh", cuma nyegah
   TERBIT token baru buat id ini). */
router.post('/:id/revoke', (req, res) => {
  try {
    const partner = lib.revokePartner(req.params.id);
    return res.json({ success: true, partner, message: `'${req.params.id}' ditandai nonaktif.` });
  } catch (e) {
    return res.status(404).json({ success: false, message: e.message });
  }
});

module.exports = router;
