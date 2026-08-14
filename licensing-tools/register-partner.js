/* ⚠️ TOOL INTERNAL VENDOR — JANGAN PERNAH DI-SHIP KE CUSTOMER.
 *
 * Daftar partner/customer di REGISTRY LOKAL (licensing-tools/partners.json,
 * DI-GITIGNORE, cuma ada di laptop/server vendor -- gak pernah ke-commit,
 * gak pernah ke-kirim ke mana-mana). generate-license.js WAJIB cek
 * registry ini dulu sebelum bisa nerbitin token -- jadi gak mungkin
 * ke-generate token buat id_mitra yang "asal ketik", harus didaftar
 * eksplisit di sini dulu. Ini yang dimaksud "terdaftar di PC saya".
 *
 * Cara pakai:
 *   Daftar/update partner baru:
 *     node licensing-tools/register-partner.js --id PT-GOKAK --name "PT Gokak Indonesia" --note "Kontrak awal 50 seat/tahun"
 *
 *   Lihat semua partner yang udah terdaftar:
 *     node licensing-tools/register-partner.js --list
 *
 *   Hapus/nonaktifkan partner (misal kontrak berakhir, gak mau bisa
 *   di-generate-in token baru lagi walau lisensi lama masih jalan):
 *     node licensing-tools/register-partner.js --revoke PT-GOKAK
 */
const fs = require('fs');
const path = require('path');

const REGISTRY_PATH = path.join(__dirname, 'partners.json');

function loadRegistry() {
  try { return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')); } catch (e) { return {}; }
}
function saveRegistry(data) {
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(data, null, 2));
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { id: null, name: null, note: null, list: false, revoke: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--list') { out.list = true; continue; }
    if (a === '--revoke') { out.revoke = args[++i]; continue; }
    if (a === '--id') { out.id = args[++i]; continue; }
    if (a === '--name') { out.name = args[++i]; continue; }
    if (a === '--note') { out.note = args[++i]; continue; }
  }
  return out;
}

function main() {
  const opts = parseArgs();
  const registry = loadRegistry();

  if (opts.list) {
    const ids = Object.keys(registry);
    if (ids.length === 0) { console.log('(belum ada partner terdaftar)'); return; }
    console.log('── Partner terdaftar ──────────────────────────');
    for (const id of ids) {
      const p = registry[id];
      console.log(`${p.active === false ? '🚫' : '✅'} ${id.padEnd(20)} ${p.name}${p.note ? ` — ${p.note}` : ''} (didaftarkan ${p.registered_at})`);
    }
    return;
  }

  if (opts.revoke) {
    if (!registry[opts.revoke]) { console.error(`❌ id_mitra '${opts.revoke}' gak ketemu di registry.`); process.exit(1); }
    registry[opts.revoke].active = false;
    saveRegistry(registry);
    console.log(`🚫 '${opts.revoke}' ditandai NONAKTIF -- generate-license.js gak akan mau nerbitin token baru buat id ini lagi (token LAMA yang udah kepasang di customer TETAP jalan sesuai exp-nya, ini cuma nyegah token BARU).`);
    return;
  }

  if (!opts.id || !opts.name) {
    console.error('❌ Wajib isi --id DAN --name.');
    console.error('   Contoh: node licensing-tools/register-partner.js --id PT-GOKAK --name "PT Gokak Indonesia"');
    console.error('   Lihat semua: node licensing-tools/register-partner.js --list');
    process.exit(1);
  }

  const isNew = !registry[opts.id];
  registry[opts.id] = {
    name: opts.name,
    note: opts.note || registry[opts.id]?.note || null,
    active: true,
    registered_at: registry[opts.id]?.registered_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  saveRegistry(registry);
  console.log(`✅ id_mitra '${opts.id}' ${isNew ? 'didaftarkan' : 'diupdate'} -- name: ${opts.name}`);
  console.log(`   Sekarang bisa generate token: node licensing-tools/generate-license.js --id ${opts.id} --customer "${opts.name}" --base 50 --years 1`);
}

main();
