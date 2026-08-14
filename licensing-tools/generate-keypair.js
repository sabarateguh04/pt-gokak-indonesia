/* ⚠️ TOOL INTERNAL VENDOR — JANGAN PERNAH DI-SHIP KE CUSTOMER.
 *
 * Generate 1 pasang RSA keypair buat sign/verify license key:
 *   - private key -> RAHASIA, cuma dipakai `generate-license.js` di
 *     mesin kita buat nandatangan license baru. JANGAN PERNAH commit
 *     ke git, jangan pernah ikut ke paket yang dikirim ke customer.
 *   - public key   -> AMAN buat di-ship bareng aplikasi (taruh di
 *     config/license-public.pem) -- cuma bisa dipakai buat VERIFIKASI
 *     tanda tangan, gak bisa dipakai buat bikin license baru.
 *
 * Jalanin SEKALI aja per "identitas vendor" (bukan per customer!).
 * Semua customer pakai public key yang SAMA, tapi tiap customer dapet
 * license TOKEN yang beda (lihat generate-license.js).
 *
 * Cara pakai:
 *   node licensing-tools/generate-keypair.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KEYS_DIR = path.join(__dirname, 'keys');
const PRIVATE_KEY_PATH = path.join(KEYS_DIR, 'license-private.pem');
const PUBLIC_KEY_PATH = path.join(__dirname, '..', 'config', 'license-public.pem');

if (fs.existsSync(PRIVATE_KEY_PATH)) {
  console.error(`❌ Sudah ada private key di ${PRIVATE_KEY_PATH}.`);
  console.error(`   Kalau emang mau generate ulang (bikin semua license lama jadi invalid!),`);
  console.error(`   hapus dulu file itu manual, baru jalanin skrip ini lagi.`);
  process.exit(1);
}

fs.mkdirSync(KEYS_DIR, { recursive: true });
fs.mkdirSync(path.dirname(PUBLIC_KEY_PATH), { recursive: true });

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

fs.writeFileSync(PRIVATE_KEY_PATH, privateKey, { mode: 0o600 });
fs.writeFileSync(PUBLIC_KEY_PATH, publicKey);

console.log('✅ Keypair berhasil dibikin.');
console.log(`   Private key (RAHASIA, jangan commit): ${PRIVATE_KEY_PATH}`);
console.log(`   Public key  (aman di-ship ke app)    : ${PUBLIC_KEY_PATH}`);
console.log('');
console.log('Langkah selanjutnya: commit public key-nya (udah di folder config/,');
console.log('otomatis ke-track git), TAPI JANGAN commit licensing-tools/keys/.');
