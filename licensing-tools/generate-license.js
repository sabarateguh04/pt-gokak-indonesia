/* ⚠️ TOOL INTERNAL VENDOR — JANGAN PERNAH DI-SHIP KE CUSTOMER.
 *
 * Generate 1 license key (JWT ditandatangani RS256) buat 1 customer.
 * Butuh private key hasil `generate-keypair.js` (licensing-tools/keys/
 * license-private.pem) -- kalau file itu gak ada, artinya belum pernah
 * generate keypair sama sekali, jalanin generate-keypair.js dulu.
 *
 * Cara pakai:
 *   node licensing-tools/generate-license.js \
 *     --customer "PT Gokak Indonesia" \
 *     --base 50 --addon 0 --years 1
 *
 * Output-nya 1 string token panjang -- itu yang dikirim ke customer,
 * mereka taruh di file `license.lic` (atau env LICENSE_KEY) di server
 * mereka. Buat PERPANJANG atau NAMBAH ADD-ON, jalanin lagi skrip ini
 * dengan angka baru -- token lama otomatis gak kepake begitu customer
 * ganti ke token baru (gak perlu "revoke" khusus, cukup dikasih yang baru).
 */
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');

const PRIVATE_KEY_PATH = path.join(__dirname, 'keys', 'license-private.pem');

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { customer: null, base: 50, addon: 0, years: 1 };
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, '');
    const val = args[i + 1];
    if (key === 'customer') out.customer = val;
    else if (key === 'base') out.base = Number(val);
    else if (key === 'addon') out.addon = Number(val);
    else if (key === 'years') out.years = Number(val);
  }
  return out;
}

function main() {
  const { customer, base, addon, years } = parseArgs();

  if (!customer) {
    console.error('❌ Wajib isi --customer "Nama Customer"');
    console.error('   Contoh: node licensing-tools/generate-license.js --customer "PT Gokak Indonesia" --base 50 --addon 0 --years 1');
    process.exit(1);
  }
  if (!fs.existsSync(PRIVATE_KEY_PATH)) {
    console.error(`❌ Private key belum ada di ${PRIVATE_KEY_PATH}`);
    console.error('   Jalanin dulu: node licensing-tools/generate-keypair.js');
    process.exit(1);
  }

  const privateKey = fs.readFileSync(PRIVATE_KEY_PATH, 'utf8');
  const expiresInSeconds = Math.round(years * 365.25 * 24 * 60 * 60);

  const token = jwt.sign(
    { customer, base_seats: base, addon_seats: addon },
    privateKey,
    { algorithm: 'RS256', expiresIn: expiresInSeconds },
  );

  const decoded = jwt.decode(token);
  console.log('✅ License key berhasil dibuat:\n');
  console.log(token);
  console.log('\n── Ringkasan ──────────────────────────────');
  console.log(`Customer     : ${customer}`);
  console.log(`Base seats   : ${base}`);
  console.log(`Add-on seats : ${addon}`);
  console.log(`Total seats  : ${base + addon}`);
  console.log(`Berlaku s/d  : ${new Date(decoded.exp * 1000).toLocaleString('id-ID')}`);
  console.log('\nKirim TOKEN di atas ke customer. Mereka simpan sebagai isi file');
  console.log('`license.lic` di root aplikasi (atau env LICENSE_KEY), lalu restart service.');
}

main();
