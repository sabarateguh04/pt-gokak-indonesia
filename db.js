const mysql = require('mysql2/promise');
require('dotenv').config();
const { resolveTablePrefix, DEFAULT_TABLE_PREFIX } = require('./helpers/schema-template');

const rawPool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'pt_gokak_indonesia',
  port: process.env.DB_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  dateStrings: true, // biar DATETIME balik sebagai string, bukan objek Date (konsisten dgn frontend)
});

// `timezone` di config createPool() cuma ngatur konversi di sisi JS,
// sedangkan kita pakai dateStrings:true (MySQL ngirim string mentah).
// Yang beneran nentuin isi NOW()/CURRENT_TIMESTAMP adalah timezone
// SESSION di server MySQL-nya sendiri -- makanya di-SET eksplisit tiap
// kali ada koneksi baru dibikin di pool, biar jamnya WIB bukan UTC.
rawPool.on('connection', (connection) => {
  connection.query("SET time_zone = '+07:00'");
});

/* ═══════════════════════════════════════════════════
   PREFIX TABEL PER MITRA (opsional, env TABLE_PREFIX).

   SELURUH kode di routes/helpers TETAP nulis nama tabel literal
   `pt_kapuk_admins`, `pt_kapuk_teknisi`, dst -- TIDAK ADA YANG DIUBAH
   di file-file itu. Substitusi ke prefix yang SEBENARNYA (misal
   `djalu_depok_admins` buat mitra "djalu depok") kejadian di SATU
   TITIK PALING BAWAH ini, tepat sebelum query beneran dikirim ke
   MySQL -- lewat Proxy yang nyegat `pool.query()` DAN `pool.
   getConnection()` (dipakai buat transaksi di teknisi.route.js &
   tiket.route.js).

   Kenapa gini, bukan refactor ~100 query di 13 file buat pakai
   variabel prefix: jauh LEBIH AMAN -- 1 titik perubahan yang gampang
   dites & di-audit, dibanding ubah manual satu-satu yang beresiko
   ada satu ke-lewat (bug diem-diem yang baru ketauan pas customer
   lapor, bukan pas testing). Default TABLE_PREFIX kosong = `pt_kapuk_`
   PERSIS SAMA kayak sebelum fitur ini ada -- fast path di bawah bikin
   ini gak ada overhead performa sama sekali buat instalasi lama.
═══════════════════════════════════════════════════ */
const TABLE_PREFIX = resolveTablePrefix();

function rewriteSql(sql) {
  if (TABLE_PREFIX === DEFAULT_TABLE_PREFIX || typeof sql !== 'string') return sql;
  return sql.split(DEFAULT_TABLE_PREFIX).join(TABLE_PREFIX);
}

function wrapConnection(conn) {
  const originalQuery = conn.query.bind(conn);
  conn.query = (sql, ...args) => originalQuery(rewriteSql(sql), ...args);
  return conn;
}

const pool = new Proxy(rawPool, {
  get(target, prop, receiver) {
    if (prop === 'query') {
      const original = target.query.bind(target);
      return (sql, ...args) => original(rewriteSql(sql), ...args);
    }
    if (prop === 'getConnection') {
      const original = target.getConnection.bind(target);
      return async (...args) => wrapConnection(await original(...args));
    }
    return Reflect.get(target, prop, receiver);
  },
});

module.exports = pool;
