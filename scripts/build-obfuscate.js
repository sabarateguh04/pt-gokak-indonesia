/* Build step: copy backend jadi folder `dist/`, obfuscate SEMUA kode
 * JS yang bakal jalan di server ATAU browser customer -- server-side
 * (server.js, routes/, helpers/, middleware/, db.js, socket.js) DAN
 * client-side (public/js/*.js + inline <script> di tiap halaman HTML).
 *
 * Dipanggil dari Dockerfile (stage builder) ATAU manual:
 *   node scripts/build-obfuscate.js
 *
 * Hasilnya di dist/ itu yang di-COPY ke image runtime akhir -- source
 * asli (routes/, helpers/, public/, dst di root project) TETEP ada di
 * git buat kerjaan sehari-hari, yang di-obfuscate cuma buat versi yang
 * DIKIRIM ke customer.
 *
 * ⚠️ FILE/HALAMAN VENDOR-ONLY (menu "Kelola Mitra", lihat
 * notesubscribe.md bagian 10-F & 12) SENGAJA GAK PERNAH ikut ke dist/
 * SAMA SEKALI, apapun env-nya pas build -- dicek lewat EXCLUDE_PATHS di
 * bawah, bukan cuma diandalkan ke VENDOR_MASTER_MODE runtime check di
 * server.js. Dua lapis: kalau salah satu kelupaan, yang satu lagi
 * tetap nutup celahnya.
 */
const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

// File/folder yang ikut ke-obfuscate + di-copy ke dist/ (server-side).
// SENGAJA eksplisit satu-satu (whitelist), bukan "semua kecuali X" --
// lebih gampang ketauan kalau ada file baru yang lupa ditambahin.
const BACKEND_ENTRIES = [
  'server.js', 'db.js', 'socket.js',
  'routes', 'helpers', 'middleware',
];

// File/folder yang ikut ke-COPY APA ADANYA, gak diobfuscate (bukan
// JS, atau emang gak ada gunanya diobfuscate) -- config/ (public key,
// bukan rahasia), schema.sql, VERSION, package.json (dependency list
// buat `npm ci --production` di stage runtime Docker), scripts/migrate.js.
// `public/` DITANGANI TERPISAH di processPublicDir() di bawah -- bukan
// disalin polos, .js & inline <script> di dalamnya ikut diobfuscate.
const COPY_AS_IS_ENTRIES = ['config', 'schema.sql', 'VERSION', 'package.json', 'package-lock.json', 'scripts/migrate.js'];

// Path relatif (dari ROOT) yang GAK BOLEH PERNAH ikut ke dist/ apapun
// alasannya -- fitur VENDOR-ONLY (kelola mitra/partner). Dicek exact
// match di setiap langkah rekursi, baik di sisi backend maupun public/.
const EXCLUDE_PATHS = new Set([
  path.join('routes', 'mitra.route.js'),
  path.join('public', 'admin', 'mitra.html'),
]);

function isExcluded(relPath) {
  return EXCLUDE_PATHS.has(relPath);
}

const OBFUSCATE_OPTIONS_SERVER = {
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

// Preset LEBIH RINGAN buat kode CLIENT-SIDE (jalan di browser customer
// sendiri, dieksekusi berkali-kali tiap halaman dibuka) -- SENGAJA
// TANPA controlFlowFlattening/deadCodeInjection (itu paling berat
// nambahin ukuran & CPU browser, worth it di server yang jalan sekali
// terus lama, kurang worth it buat kode yang di-load ulang tiap
// navigasi halaman) & TANPA selfDefending (gampang bentrok sama
// minifier/dev tools browser, resiko bikin dashboard nge-freeze kalau
// ada race condition). Tetap dapet manfaat utama: variabel/fungsi jadi
// nama hex gak bermakna + semua string literal ke-encode base64 --
// itu yang bikin "Inspect Element" gak lagi kebaca polos.
const OBFUSCATE_OPTIONS_CLIENT = {
  compact: true,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.75,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,
  selfDefending: false,
};

function obfuscate(code, options) {
  return JavaScriptObfuscator.obfuscate(code, options).getObfuscatedCode();
}

function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }

function copyRecursive(src, dst, relBase = '') {
  const stat = fs.statSync(src);
  const rel = relBase;
  if (isExcluded(rel)) return;
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dst, entry), path.join(rel, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

function obfuscateRecursive(src, dst, relBase) {
  const stat = fs.statSync(src);
  if (isExcluded(relBase)) return;
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      obfuscateRecursive(path.join(src, entry), path.join(dst, entry), path.join(relBase, entry));
    }
    return;
  }
  if (!src.endsWith('.js')) { copyRecursive(src, dst, relBase); return; }

  const code = fs.readFileSync(src, 'utf8');
  const obfuscated = obfuscate(code, OBFUSCATE_OPTIONS_SERVER);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, obfuscated);
}

// Cari semua <script>...</script> TANPA atribut src (inline) dan
// obfuscate isinya di tempat -- <script src="..."> (rujukan ke file
// eksternal) dibiarkan tag-nya, file yang dirujuk diobfuscate
// terpisah lewat processPublicDir() di bawah.
const INLINE_SCRIPT_RE = /(<script(?![^>]*\bsrc=)[^>]*>)([\s\S]*?)(<\/script>)/gi;

function obfuscateInlineScripts(html) {
  return html.replace(INLINE_SCRIPT_RE, (full, openTag, code, closeTag) => {
    if (!code.trim()) return full; // <script> kosong, gak ada yang diobfuscate
    try {
      return `${openTag}${obfuscate(code, OBFUSCATE_OPTIONS_CLIENT)}${closeTag}`;
    } catch (e) {
      console.warn(`   ⚠️  gagal obfuscate 1 blok inline script (dipertahankan apa adanya): ${e.message}`);
      return full;
    }
  });
}

/** Tangani public/ SATU-SATU (bukan copy folder polos kayak sebelumnya)
 *  -- .js diobfuscate, .html inline scriptnya diobfuscate, sisanya
 *  (css/gambar/dst) disalin apa adanya. File yang di-EXCLUDE_PATHS
 *  (mitra.html) di-skip TOTAL, gak ikut ke dist sama sekali. */
function processPublicDir(src, dst, relBase) {
  const stat = fs.statSync(src);
  if (isExcluded(relBase)) { console.log(`   dikecualikan: ${relBase} (vendor-only)`); return; }

  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      processPublicDir(path.join(src, entry), path.join(dst, entry), path.join(relBase, entry));
    }
    return;
  }

  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (src.endsWith('.js')) {
    const code = fs.readFileSync(src, 'utf8');
    fs.writeFileSync(dst, obfuscate(code, OBFUSCATE_OPTIONS_CLIENT));
  } else if (src.endsWith('.html')) {
    const html = fs.readFileSync(src, 'utf8');
    fs.writeFileSync(dst, obfuscateInlineScripts(html));
  } else {
    fs.copyFileSync(src, dst);
  }
}

function main() {
  console.log('🔨 Build dist/ (obfuscated) ...');
  rmrf(DIST);
  fs.mkdirSync(DIST, { recursive: true });

  for (const entry of BACKEND_ENTRIES) {
    const src = path.join(ROOT, entry);
    if (!fs.existsSync(src)) { console.warn(`⚠️  ${entry} gak ketemu, skip`); continue; }
    obfuscateRecursive(src, path.join(DIST, entry), entry);
    console.log(`   obfuscated (server): ${entry}`);
  }

  for (const entry of COPY_AS_IS_ENTRIES) {
    const src = path.join(ROOT, entry);
    if (!fs.existsSync(src)) { console.warn(`⚠️  ${entry} gak ketemu, skip`); continue; }
    copyRecursive(src, path.join(DIST, entry), entry);
    console.log(`   copied:     ${entry}`);
  }

  const publicSrc = path.join(ROOT, 'public');
  processPublicDir(publicSrc, path.join(DIST, 'public'), 'public');
  console.log('   obfuscated (client): public/**/*.js + inline <script> di public/**/*.html');

  console.log('✅ Selesai. Hasil ada di dist/ -- ini yang di-COPY ke image Docker final,');
  console.log('   BUKAN source asli di root project. Fitur vendor-only (Kelola Mitra) TIDAK IKUT.');
}

main();
