/* ⚠️ VENDOR-ONLY. Lib bersama buat "nerbitin lisensi + siapin paket
 * Docker buat 1 mitra" -- dipakai BARENGAN sama:
 *   - CLI: licensing-tools/register-partner.js, generate-license.js
 *   - Web: routes/mitra.route.js (menu "Kelola Mitra" di dashboard,
 *     CUMA aktif kalau VENDOR_MASTER_MODE=true, lihat server.js)
 *
 * Satu tempat buat logic ini -- sebelumnya generate-license.js &
 * register-partner.js masing-masing punya salinan sendiri, gampang
 * ke-lupa disinkronin kalau ada perubahan.
 *
 * Seluruh folder licensing-tools/ TERMASUK yang DIKECUALIKAN dari
 * image customer (lihat .dockerignore + scripts/build-obfuscate.js)
 * -- private key & registry mitra gak boleh pernah ke-bundle ke
 * instalasi manapun selain milik vendor.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { renderSchema } = require('../../helpers/schema-template');

const ROOT = path.join(__dirname, '..', '..');
const PRIVATE_KEY_PATH = path.join(__dirname, '..', 'keys', 'license-private.pem');
const REGISTRY_PATH = path.join(__dirname, '..', 'partners.json');
const DOCKER_PACKAGES_DIR = path.join(ROOT, 'docker');

function loadRegistry() {
  try { return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')); } catch (e) { return {}; }
}
function saveRegistry(data) {
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(data, null, 2));
}

/** "PT Gokak Indonesia" -> "pt_gokak_indonesia" -- dipakai konsisten
 *  buat id_mitra, nama folder docker/, DAN turunan nama
 *  DB_NAME (`mitra_<id>`) & TABLE_PREFIX (`<id>_`) tiap mitra. */
function slugify(name) {
  return String(name).trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'mitra';
}

function registerOrUpdatePartner({ id, name, note }) {
  if (!id || !name) throw new Error('id dan name wajib diisi');
  const registry = loadRegistry();
  const isNew = !registry[id];
  registry[id] = {
    ...registry[id],
    name,
    note: note || registry[id]?.note || null,
    active: true,
    registered_at: registry[id]?.registered_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  saveRegistry(registry);
  return { partner: registry[id], isNew };
}

function revokePartner(id) {
  const registry = loadRegistry();
  if (!registry[id]) throw new Error(`id_mitra '${id}' gak ketemu di registry.`);
  registry[id].active = false;
  registry[id].updated_at = new Date().toISOString();
  saveRegistry(registry);
  return registry[id];
}

function ensurePrivateKey() {
  if (!fs.existsSync(PRIVATE_KEY_PATH)) {
    throw new Error(`Private key belum ada di ${PRIVATE_KEY_PATH} -- jalanin dulu: node licensing-tools/generate-keypair.js`);
  }
}

/** Generate token JWT RS256 buat 1 mitra yang SUDAH terdaftar & aktif.
 *  Token + ringkasannya DISIMPEN JUGA ke registry (`last_token` dst)
 *  -- dipakai refreshPackage() buat regenerate paket Docker (misal pas
 *  ada versi baru aplikasi) TANPA nerbitin lisensi baru. */
function generateLicenseToken({ id, customer, base, addon, years }) {
  ensurePrivateKey();
  const registry = loadRegistry();
  const partner = registry[id];
  if (!partner) throw new Error(`id_mitra '${id}' belum terdaftar di registry. Daftarkan dulu lewat register-partner.js atau menu Kelola Mitra.`);
  if (partner.active === false) throw new Error(`id_mitra '${id}' sudah di-revoke (nonaktif) -- gak bisa generate token baru.`);

  const privateKey = fs.readFileSync(PRIVATE_KEY_PATH, 'utf8');
  const expiresInSeconds = Math.round(Number(years) * 365.25 * 24 * 60 * 60);
  const token = jwt.sign(
    { id_mitra: id, customer, base_seats: Number(base), addon_seats: Number(addon) || 0 },
    privateKey,
    { algorithm: 'RS256', expiresIn: expiresInSeconds },
  );
  const decoded = jwt.decode(token);

  partner.last_token = token;
  partner.last_token_meta = { base_seats: decoded.base_seats, addon_seats: decoded.addon_seats, exp: decoded.exp, issued_at: new Date().toISOString() };
  partner.updated_at = new Date().toISOString();
  saveRegistry(registry);

  return { token, decoded };
}

function readAppVersion() {
  try { return fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim(); } catch (e) { return '1.0.0'; }
}

/** Ambil JWT_SECRET dari .env LAMA di folder itu kalau ada (dipanggil
 *  ulang buat mitra yang SUDAH ADA lewat reissue/refresh) -- biar
 *  instalasi yang UDAH JALAN gak ke-invalidate semua sesi login-nya
 *  gara-gara JWT_SECRET ganti tiap kali vendor nerbitin token baru
 *  atau nge-refresh paket buat versi aplikasi terbaru. */
function readExistingJwtSecret(folder) {
  const envPath = path.join(folder, '.env');
  if (!fs.existsSync(envPath)) return null;
  const match = fs.readFileSync(envPath, 'utf8').match(/^JWT_SECRET=(.+)$/m);
  return match ? match[1].trim() : null;
}

/**
 * Bikin/refresh folder `docker/<id_mitra>/` isinya SEMUA yang perlu
 * dikirim ke mitra itu: docker-compose.yml (tag image ikut VERSION
 * TERBARU tiap dipanggil ulang), .env (DB_NAME=`mitra_<id>`,
 * TABLE_PREFIX=`<id>_` -- lihat helpers/schema-template.js buat
 * gimana ini beneran dipakai pas migrate.js jalan; JWT_SECRET
 * DIPERTAHANKAN kalau folder-nya udah pernah ada), schema.sql (salinan
 * yang SUDAH di-render pakai nama DB/prefix mitra ini, biar jelas
 * kebaca isinya walau migrate.js yang beneran ngejalaninnya nanti),
 * LICENSE-TOKEN.txt, README.md, Caddyfile.example.
 *
 * Folder ini (docker/) DI-GITIGNORE total -- isinya rahasia PER MITRA
 * (JWT_SECRET, token lisensi), gak boleh ke-commit.
 */
function scaffoldDockerPackage({ id, customer, token, decoded }) {
  const folder = path.join(DOCKER_PACKAGES_DIR, id);
  const jwtSecret = readExistingJwtSecret(folder) || crypto.randomBytes(48).toString('hex');
  fs.mkdirSync(folder, { recursive: true });

  const dbName = `mitra_${id}`;
  const tablePrefix = `${id}_`;

  const version = readAppVersion();
  let compose = fs.readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8');
  compose = compose.replace(/ptgokak\/tracking-app:[\w.\-]+/, `ptgokak/tracking-app:${version}`);
  fs.writeFileSync(path.join(folder, 'docker-compose.yml'), compose);

  const rawSchema = fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8');
  fs.writeFileSync(path.join(folder, 'schema.sql'), renderSchema(rawSchema, { dbName, tablePrefix }));

  const caddySrc = path.join(ROOT, 'Caddyfile.example');
  if (fs.existsSync(caddySrc)) fs.copyFileSync(caddySrc, path.join(folder, 'Caddyfile.example'));

  const validUntil = new Date(decoded.exp * 1000).toLocaleDateString('id-ID');
  const env = `PORT=3010

DB_HOST=host.docker.internal
DB_USER=
DB_PASSWORD=
DB_NAME=${dbName}
DB_PORT=3306

JWT_SECRET=${jwtSecret}

FACTORY_LAT=
FACTORY_LNG=

# ID mitra instalasi ini -- HARUS SAMA PERSIS dengan yang tertanam di
# LICENSE-TOKEN.txt sebelah file ini. JANGAN diubah manual.
ID_MITRA=${id}

# Prefix tabel KHUSUS mitra ini (misal ${tablePrefix}admins,
# ${tablePrefix}teknisi, dst) -- dibuat OTOMATIS pas container pertama
# jalan (lihat scripts/migrate.js), JANGAN diubah manual setelah
# instalasi berjalan (nama tabel yang UDAH ADA gak ikut berubah).
TABLE_PREFIX=${tablePrefix}

VENDOR_SUPPORT_EMAIL=${process.env.VENDOR_SUPPORT_EMAIL || 'support@vendor-anda.com'}

# Isi kalau mau aktifkan phone-home ke License Service vendor (opsional).
# LICENSE_SERVICE_URL=
`;
  fs.writeFileSync(path.join(folder, '.env'), env);

  const tokenFile = `Token lisensi untuk: ${customer} (id_mitra: ${id})
Berlaku s/d: ${validUntil}
Dibuat: ${new Date().toLocaleString('id-ID')}

── TEMPEL TOKEN DI BAWAH INI lewat menu 🔑 Lisensi di dashboard ──────

${token}

── Cara pakai ──────────────────────────────────────────────────────
1. Login ke dashboard admin (akun default ada di README.md sebelah).
2. Buka menu 🔑 Lisensi.
3. Tempel token di atas ke kotak "Pasang Token Lisensi Baru", klik Aktifkan.
`;
  fs.writeFileSync(path.join(folder, 'LICENSE-TOKEN.txt'), tokenFile);

  const readme = `# Paket Instalasi — ${customer}

id_mitra: \`${id}\`
Database: \`${dbName}\` (prefix tabel: \`${tablePrefix}\`)
Dibuat/diperbarui: ${new Date().toLocaleString('id-ID')}

## Isi folder ini
- \`docker-compose.yml\` — jalanin dengan \`docker compose up -d\`
- \`.env\` — SUDAH DIISI (kredensial DB masih kosong, isi dulu sebelum jalan)
- \`schema.sql\` — referensi skema KHUSUS mitra ini (dibuat OTOMATIS pas container pertama jalan, gak perlu dijalanin manual)
- \`LICENSE-TOKEN.txt\` — token lisensi punya mitra ini, tempel lewat dashboard
- \`Caddyfile.example\` — opsional, buat akses lewat HTTPS/domain sendiri (bukan http://ip:3010 polos)

## Langkah instalasi singkat
1. Isi \`DB_HOST\`/\`DB_USER\`/\`DB_PASSWORD\`/\`FACTORY_LAT\`/\`FACTORY_LNG\` di \`.env\`.
2. \`docker compose up -d\`
3. Buka \`http://localhost:3010/admin/login\` — login \`admin\` / \`password123\`, LANGSUNG GANTI PASSWORD.
4. Buka menu 🔑 Lisensi, tempel isi \`LICENSE-TOKEN.txt\`, klik Aktifkan.
5. (Opsional, direkomendasikan) Setup HTTPS lewat domain sendiri -- lihat \`Caddyfile.example\`.

## Update ke versi aplikasi baru nanti
Vendor kirim ulang \`docker-compose.yml\` (tag image versi baru) lewat
menu "🔁 Refresh Paket" -- **data & lisensi yang UDAH JALAN gak
kehapus/kena reset**, cukup timpa \`docker-compose.yml\` yang lama &
\`docker compose up -d\` lagi.

Panduan lengkap + troubleshooting: lihat \`INSTALL-CUSTOMER.md\` di repo utama.
`;
  fs.writeFileSync(path.join(folder, 'README.md'), readme);

  return folder;
}

/**
 * Regenerate folder docker/<id>/ pakai TOKEN YANG SUDAH ADA (gak
 * nerbitin lisensi baru sama sekali) -- buat kasus "ada update
 * aplikasi versi baru, mitra yang udah jalan tinggal ganti
 * docker-compose.yml-nya" TANPA bikin seolah-olah lisensinya berubah.
 * Butuh mitra itu udah PERNAH di-generate-in token minimal sekali
 * (create atau reissue) -- kalau belum, gak ada `last_token` buat
 * dipakai ulang.
 */
function refreshPackage({ id }) {
  const registry = loadRegistry();
  const partner = registry[id];
  if (!partner) throw new Error(`id_mitra '${id}' gak ketemu di registry.`);
  if (!partner.last_token) throw new Error(`id_mitra '${id}' belum pernah punya token lisensi -- generate dulu (bukan refresh).`);

  const decoded = { base_seats: partner.last_token_meta?.base_seats, addon_seats: partner.last_token_meta?.addon_seats, exp: partner.last_token_meta?.exp };
  return scaffoldDockerPackage({ id, customer: partner.name, token: partner.last_token, decoded });
}

module.exports = {
  loadRegistry, saveRegistry, slugify,
  registerOrUpdatePartner, revokePartner,
  generateLicenseToken, scaffoldDockerPackage, refreshPackage,
  REGISTRY_PATH, DOCKER_PACKAGES_DIR,
};
