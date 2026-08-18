/* Substitusi nama database & prefix tabel di teks schema.sql --
 * dipakai BARENGAN oleh scripts/migrate.js (jalan di instalasi
 * CUSTOMER, pas container pertama nyala) DAN
 * licensing-tools/lib/issue-license.js (VENDOR-ONLY, pas scaffold
 * folder docker/<id_mitra>/) -- satu tempat, biar substitusinya
 * KONSISTEN, gak nulis regex yang sama 2x di 2 tempat beda yang
 * gampang ke-lupa disinkronin.
 *
 * schema.sql yang di-COMMIT ke git TETAP pakai nama "template" default
 * (`pt_gokak_indonesia` / `pt_kapuk_`) apa adanya -- gak pernah diedit
 * manual per mitra, substitusinya SELALU di runtime/build-time lewat
 * fungsi ini.
 */
const DEFAULT_DB_NAME = 'pt_gokak_indonesia';
const DEFAULT_TABLE_PREFIX = 'pt_kapuk_';

function renderSchema(rawSql, { dbName, tablePrefix } = {}) {
  let sql = rawSql;
  if (dbName && dbName !== DEFAULT_DB_NAME) {
    sql = sql.split(DEFAULT_DB_NAME).join(dbName);
  }
  if (tablePrefix && tablePrefix !== DEFAULT_TABLE_PREFIX) {
    sql = sql.split(DEFAULT_TABLE_PREFIX).join(tablePrefix);
  }
  return sql;
}

/** Dibaca app (db.js) & migrate.js -- default TETAP `pt_kapuk_` kalau
 *  env TABLE_PREFIX kosong, biar 100% backward compatible sama
 *  instalasi/database yang udah ada SEBELUM fitur multi-prefix ini. */
function resolveTablePrefix() {
  return process.env.TABLE_PREFIX || DEFAULT_TABLE_PREFIX;
}

module.exports = { renderSchema, resolveTablePrefix, DEFAULT_DB_NAME, DEFAULT_TABLE_PREFIX };
