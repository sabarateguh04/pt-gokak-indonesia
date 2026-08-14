/* ⚠️ TOOL INTERNAL VENDOR — JANGAN PERNAH DI-SHIP KE CUSTOMER.
 *
 * Generate 1 license key (JWT ditandatangani RS256) buat 1 customer.
 * Butuh private key hasil `generate-keypair.js` (licensing-tools/keys/
 * license-private.pem) -- kalau file itu gak ada, artinya belum pernah
 * generate keypair sama sekali, jalanin generate-keypair.js dulu.
 *
 * WAJIB id_mitra yang SUDAH TERDAFTAR di registry lokal
 * (licensing-tools/partners.json, lihat register-partner.js) --
 * kalau belum, daftarkan dulu:
 *   node licensing-tools/register-partner.js --id PT-GOKAK --name "PT Gokak Indonesia"
 *
 * Cara pakai:
 *   node licensing-tools/generate-license.js \
 *     --id PT-GOKAK --customer "PT Gokak Indonesia" \
 *     --base 50 --addon 0 --years 1
 *
 * Output-nya 1 string token panjang -- itu yang dikirim ke customer,
 * mereka tempel lewat menu 🔑 Lisensi di dashboard mereka (atau taruh
 * di file `license.lic` / env LICENSE_KEY manual kalau perlu). Buat
 * PERPANJANG atau NAMBAH ADD-ON, jalanin lagi skrip ini dengan angka
 * baru -- token lama otomatis gak kepake begitu customer ganti ke
 * token baru (gak perlu "revoke" khusus, cukup dikasih yang baru).
 *
 * `id_mitra` ini JUGA yang WAJIB sama persis dengan env `ID_MITRA` di
 * `.env` instalasi customer itu (lihat helpers/license.js) -- kalau
 * gak cocok, app nolak login walau tanda tangan tokennya sah. Ini
 * ngunci 1 token cuma kepake di instalasi yang emang dituju vendor pas
 * nyiapin paket customer itu, gak bisa asal dicomot buat instalasi lain.
 */
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');

const PRIVATE_KEY_PATH = path.join(__dirname, 'keys', 'license-private.pem');
const REGISTRY_PATH = path.join(__dirname, 'partners.json');

function loadRegistry() {
  try { return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')); } catch (e) { return {}; }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { id: null, customer: null, base: 50, addon: 0, years: 1 };
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, '');
    const val = args[i + 1];
    if (key === 'id') out.id = val;
    else if (key === 'customer') out.customer = val;
    else if (key === 'base') out.base = Number(val);
    else if (key === 'addon') out.addon = Number(val);
    else if (key === 'years') out.years = Number(val);
  }
  return out;
}

function main() {
  const { id, customer, base, addon, years } = parseArgs();

  if (!id || !customer) {
    console.error('❌ Wajib isi --id DAN --customer.');
    console.error('   Contoh: node licensing-tools/generate-license.js --id PT-GOKAK --customer "PT Gokak Indonesia" --base 50 --addon 0 --years 1');
    process.exit(1);
  }
  if (!fs.existsSync(PRIVATE_KEY_PATH)) {
    console.error(`❌ Private key belum ada di ${PRIVATE_KEY_PATH}`);
    console.error('   Jalanin dulu: node licensing-tools/generate-keypair.js');
    process.exit(1);
  }

  const registry = loadRegistry();
  const partner = registry[id];
  if (!partner) {
    console.error(`❌ id_mitra '${id}' belum terdaftar di registry lokal (licensing-tools/partners.json).`);
    console.error(`   Daftarkan dulu: node licensing-tools/register-partner.js --id ${id} --name "${customer}"`);
    process.exit(1);
  }
  if (partner.active === false) {
    console.error(`❌ id_mitra '${id}' sudah di-REVOKE (nonaktif) di registry -- generate-license.js gak akan nerbitin token baru buat id ini.`);
    console.error('   Kalau ini keliru, daftarkan ulang: node licensing-tools/register-partner.js --id ' + id + ' --name "' + customer + '"');
    process.exit(1);
  }

  const privateKey = fs.readFileSync(PRIVATE_KEY_PATH, 'utf8');
  const expiresInSeconds = Math.round(years * 365.25 * 24 * 60 * 60);

  const token = jwt.sign(
    { id_mitra: id, customer, base_seats: base, addon_seats: addon },
    privateKey,
    { algorithm: 'RS256', expiresIn: expiresInSeconds },
  );

  const decoded = jwt.decode(token);
  console.log('✅ License key berhasil dibuat:\n');
  console.log(token);
  console.log('\n── Ringkasan ──────────────────────────────');
  console.log(`ID Mitra     : ${id}`);
  console.log(`Customer     : ${customer}`);
  console.log(`Base seats   : ${base}`);
  console.log(`Add-on seats : ${addon}`);
  console.log(`Total seats  : ${base + addon}`);
  console.log(`Berlaku s/d  : ${new Date(decoded.exp * 1000).toLocaleString('id-ID')}`);
  console.log('\n⚠️  PENTING: pastikan .env instalasi customer ini punya baris:');
  console.log(`   ID_MITRA=${id}`);
  console.log('   (persis sama, case-sensitive) -- kalau beda/gak diisi sama sekali,');
  console.log('   app bakal nolak token ini walau tanda tangannya sah.');
  console.log('\nKirim TOKEN di atas ke customer. Mereka tempel lewat menu 🔑 Lisensi');
  console.log('di dashboard admin (atau file `license.lic` / env LICENSE_KEY manual).');
}

main();
