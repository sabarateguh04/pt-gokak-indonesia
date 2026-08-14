/* Build step: copy backend jadi folder `dist/`, obfuscate semua file
 * .js (server.js, routes/, helpers/, middleware/, db.js, socket.js) --
 * TAPI JANGAN obfuscate public/ (kode client-side, browser yang jalanin
 * langsung, minify/obfuscate berlebihan gampang bikin bug susah dilacak
 * & gak sepadan soalnya toh browser selalu bisa "view-source" apapun
 * yang dikirim ke dia).
 *
 * Dipanggil dari Dockerfile (stage builder) ATAU manual:
 *   node scripts/build-obfuscate.js
 *
 * Hasilnya di dist/ itu yang di-COPY ke image runtime akhir -- source
 * asli (routes/, helpers/, dst di root project) TETEP ada di git buat
 * kerjaan sehari-hari, yang di-obfuscate cuma buat versi yang DIKIRIM
 * ke customer.
 */
const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

// File/folder yang ikut ke-obfuscate + di-copy ke dist/. SENGAJA
// eksplisit satu-satu (whitelist), bukan "semua kecuali X" -- lebih
// gampang ketauan kalau ada file baru yang lupa ditambahin ke sini.
const BACKEND_ENTRIES = [
  'server.js', 'db.js', 'socket.js',
  'routes', 'helpers', 'middleware',
];

// File/folder yang ikut ke-COPY APA ADANYA (gak di-obfuscate) --
// public/ (client-side), config/ (public key, bukan rahasia),
// schema.sql, VERSION, package.json (butuh dependency list buat
// `npm ci --production` di stage runtime Docker), scripts/migrate.js
// (dipanggil Dockerfile sebelum server.js jalan, lihat komentar di
// situ -- SENGAJA cuma file itu doang, BUKAN seluruh folder scripts/,
// biar build-obfuscate.js sendiri -- tool dev, gak perlu di runtime --
// gak ikut kebawa ke image final).
const COPY_AS_IS_ENTRIES = ['public', 'config', 'schema.sql', 'VERSION', 'package.json', 'package-lock.json', 'scripts/migrate.js'];

const OBFUSCATE_OPTIONS = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.75,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.4,
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.75,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false, // JANGAN true -- bisa ngerusak nama yang dipakai require() dst
  selfDefending: true,
  // disableConsoleOutput: false -- SENGAJA dibiarin console.log aktif,
  // itu satu-satunya cara vendor bisa liat log dari server customer
  // (lewat `docker logs`) buat bantu debug kalau ada laporan bug.
};

function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }

function copyRecursive(src, dst) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) copyRecursive(path.join(src, entry), path.join(dst, entry));
  } else {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

function obfuscateRecursive(src, dst) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) obfuscateRecursive(path.join(src, entry), path.join(dst, entry));
    return;
  }
  if (!src.endsWith('.js')) { copyRecursive(src, dst); return; }

  const code = fs.readFileSync(src, 'utf8');
  const obfuscated = JavaScriptObfuscator.obfuscate(code, OBFUSCATE_OPTIONS).getObfuscatedCode();
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, obfuscated);
}

function main() {
  console.log('🔨 Build dist/ (obfuscated) ...');
  rmrf(DIST);
  fs.mkdirSync(DIST, { recursive: true });

  for (const entry of BACKEND_ENTRIES) {
    const src = path.join(ROOT, entry);
    if (!fs.existsSync(src)) { console.warn(`⚠️  ${entry} gak ketemu, skip`); continue; }
    obfuscateRecursive(src, path.join(DIST, entry));
    console.log(`   obfuscated: ${entry}`);
  }

  for (const entry of COPY_AS_IS_ENTRIES) {
    const src = path.join(ROOT, entry);
    if (!fs.existsSync(src)) { console.warn(`⚠️  ${entry} gak ketemu, skip`); continue; }
    copyRecursive(src, path.join(DIST, entry));
    console.log(`   copied:     ${entry}`);
  }

  console.log('✅ Selesai. Hasil ada di dist/ -- ini yang di-COPY ke image Docker final,');
  console.log('   BUKAN source asli di root project.');
}

main();
