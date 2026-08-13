const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
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
pool.on('connection', (connection) => {
  connection.query("SET time_zone = '+07:00'");
});

module.exports = pool;
