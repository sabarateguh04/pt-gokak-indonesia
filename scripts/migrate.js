/* Migrasi database OTOMATIS buat instalasi customer baru. Dipanggil
 * dari Dockerfile (CMD) sebelum `node server.js` jalan -- tujuannya
 * customer GAK PERLU jalanin `mysql -u root -p < schema.sql` manual
 * dari command line. Cukup isi kredensial DB di `.env`/`docker-compose.yml`,
 * `docker compose up`, skema + akun admin default langsung kebentuk
 * sendiri kalau memang belum ada.
 *
 * ⚠️ SANGAT SENGAJA cuma jalan SEKALI & idempotent -- `schema.sql`
 * sendiri isinya `DROP TABLE IF EXISTS ...` di awal (RESET TOTAL, lihat
 * komentar di file itu). Kalau script ini dijalanin TANPA pengecekan
 * "tabelnya udah ada belum" di SETIAP restart container, data customer
 * bakal KEHAPUS tiap kali container-nya di-restart/di-update.
 * JANGAN PERNAH hapus pengecekan tabel admin di bawah ini.
 *
 * Bisa juga dipanggil manual pas development: `npm run migrate`.
 */
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config();
const { renderSchema, resolveTablePrefix } = require('../helpers/schema-template');

const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_PORT = Number(process.env.DB_PORT) || 3306;
const DB_USER = process.env.DB_USER || 'root';
const DB_PASSWORD = process.env.DB_PASSWORD || '';
const DB_NAME = process.env.DB_NAME || 'pt_gokak_indonesia';
const TABLE_PREFIX = resolveTablePrefix();

// MySQL di docker-compose kadang butuh beberapa detik buat siap nerima
// koneksi pas baru nyala bareng app-nya -- retry dulu sebelum nyerah,
// biar gak keliatan "error" padahal cuma soal timing start-up.
const MAX_RETRY = 15;
const RETRY_DELAY_MS = 2000;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function connectWithRetry() {
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      return await mysql.createConnection({
        host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASSWORD,
        multipleStatements: true, // WAJIB -- schema.sql isinya banyak statement sekaligus
      });
    } catch (e) {
      if (attempt === MAX_RETRY) throw e;
      console.log(`[MIGRATE] Belum bisa konek ke MySQL (${e.code || e.message}), coba lagi ${attempt}/${MAX_RETRY}...`);
      await sleep(RETRY_DELAY_MS);
    }
  }
}

async function main() {
  const conn = await connectWithRetry();
  const adminTable = `${TABLE_PREFIX}admins`;

  const [dbs] = await conn.query('SHOW DATABASES LIKE ?', [DB_NAME]);
  if (dbs.length > 0) {
    await conn.query(`USE \`${DB_NAME}\``);
    const [tables] = await conn.query(`SHOW TABLES LIKE ?`, [adminTable]);
    if (tables.length > 0) {
      console.log(`[MIGRATE] Database '${DB_NAME}' sudah ada isinya (tabel ${adminTable} ketemu) -- SKIP, gak ada yang dijalanin. Ini mencegah data ke-reset tiap restart/update.`);
      await conn.end();
      return;
    }
  }

  console.log(`[MIGRATE] Database '${DB_NAME}' belum ada / masih kosong -- menjalankan schema.sql (prefix tabel: ${TABLE_PREFIX})...`);
  // schema.sql yang di-COMMIT ke git isinya nama "template" default
  // (`pt_gokak_indonesia` / `pt_kapuk_`) -- renderSchema() substitusi
  // ke DB_NAME/TABLE_PREFIX SEBENARNYA instalasi ini. Tanpa ini,
  // migrasi bakal diam-diam kebentuk pakai nama DEFAULT (bukan yang
  // dipakai app lewat db.js/TABLE_PREFIX), app-nya nanti nyambung ke
  // database/tabel yang ternyata kosong/gak ada.
  const rawSql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  const sql = renderSchema(rawSql, { dbName: DB_NAME, tablePrefix: TABLE_PREFIX });
  await conn.query(sql);
  console.log(`[MIGRATE] Selesai. Skema (11 tabel, prefix '${TABLE_PREFIX}') + akun admin default sudah dibuat -- lihat schema.sql buat kredensial awalnya, GANTI PASSWORD-nya begitu login pertama.`);
  await conn.end();
}

main().catch((e) => {
  console.error('[MIGRATE] Gagal:', e.message);
  process.exit(1);
});
