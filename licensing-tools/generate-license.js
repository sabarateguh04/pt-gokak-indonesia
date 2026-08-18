/* ⚠️ TOOL INTERNAL VENDOR — JANGAN PERNAH DI-SHIP KE CUSTOMER.
 *
 * Generate 1 license key (JWT ditandatangani RS256) buat 1 mitra yang
 * SUDAH TERDAFTAR di registry lokal (lihat register-partner.js) --
 * kalau belum, daftarkan dulu:
 *   node licensing-tools/register-partner.js --id pt_gokak --name "PT Gokak Indonesia"
 *
 * Cara pakai:
 *   node licensing-tools/generate-license.js \
 *     --id pt_gokak --customer "PT Gokak Indonesia" \
 *     --base 50 --addon 0 --years 1
 *
 * Ini CUMA generate token-nya doang (buat kirim manual/renewal cepat).
 * Kalau butuh SEKALIAN paket Docker lengkap (docker-compose.yml, .env,
 * schema.sql, dst) buat instalasi BARU, pakai menu "Kelola Mitra" di
 * dashboard (VENDOR_MASTER_MODE=true) -- itu manggil lib yang sama
 * (lib/issue-license.js) TERUS sekalian scaffold folder docker/<id>/.
 *
 * `id_mitra` WAJIB sama persis dengan env `ID_MITRA` di `.env`
 * instalasi customer itu (lihat helpers/license.js) -- kalau gak
 * cocok, app nolak login walau tanda tangan tokennya sah. Ini ngunci 1
 * token cuma kepake di instalasi yang emang dituju vendor.
 */
const lib = require('./lib/issue-license');

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
    console.error('   Contoh: node licensing-tools/generate-license.js --id pt_gokak --customer "PT Gokak Indonesia" --base 50 --addon 0 --years 1');
    process.exit(1);
  }

  let result;
  try {
    result = lib.generateLicenseToken({ id, customer, base, addon, years });
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }

  const { token, decoded } = result;
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
