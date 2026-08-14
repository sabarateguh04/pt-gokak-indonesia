/* Perhitungan KPI kehadiran (jam online, di dalam vs di luar area
 * pabrik) dari data mentah `pt_kapuk_teknisi_lokasi` (ping GPS tiap
 * ~30 detik selama status ONLINE/ON_TASK).
 *
 * PENDEKATAN: gak ada tabel sesi terpisah -- durasi dihitung dari GAP
 * ANTAR PING. Gap yang wajar (<= MAX_GAP_SECONDS, toleransi ping
 * lambat/telat network) dianggap "online" penuh; gap yang jauh lebih
 * lama dianggap disconnect (device mati/tab ditutup tanpa set OFFLINE
 * dulu) dan DIPOTONG ke MAX_GAP_SECONDS -- sisanya gak dihitung.
 *
 * Semua fungsi di sini kerja di atas STRING datetime "YYYY-MM-DD
 * HH:MM:SS" APA ADANYA (dari mysql2 dateStrings:true + session
 * time_zone udah di-SET ke WIB di db.js) -- SENGAJA gak lewat
 * `new Date(str)`, karena itu bakal diinterpretasi pakai timezone OS
 * server Node, bukan WIB, dan bisa salah tanggal/jam kalau servernya
 * gak di-set WIB. Semua epoch di modul ini cuma "epoch semu" buat
 * hitung SELISIH, bukan buat baca jam UTC asli.
 */

const PING_INTERVAL_SECONDS = 30; // sinkron sama public/js/teknisi-tracker.js -- 30 detik biar hemat baterai HP teknisi
// Toleransi disconnect -- gap antar ping yang masih dianggap "online
// nyambung" (jeda network/GPS wajar: masuk lift, sinyal ngedip bentar,
// dst), dikasih lantai minimum biar tetep longgar walau interval-nya
// dikecilin lagi suatu saat. Ini JUGA yang paling nentuin panjang-
// pendeknya daftar "rentang waktu online" (makin ketat, makin gampang
// kepecah jadi banyak sesi kecil).
const MAX_GAP_SECONDS = Math.max(PING_INTERVAL_SECONDS * 3, 60);

// Toleransi "flicker" GPS di deket garis batas poligon area -- posisi
// yang goyang beberapa meter di pinggir area bisa keluar-masuk status
// in_area tiap ping padahal orangnya diem di tempat. Kalau durasi
// "keluar"-nya di bawah ini DAN abis itu balik lagi (bukan disconnect),
// dianggap noise -- sesi di-dalam/luar-area-nya TETEP NYAMBUNG, gak
// dianggap sesi baru. Ini cuma ngaruh ke daftar rentang yang
// ditampilin, BUKAN ke total detik (itu tetep presisi dari summarizeByDay).
// 1.5x interval normal -- cukup buat nutupin 1 ping nyasar doang, gak
// nutupin excursion beneran (yang biasanya lebih dari 1 ping).
const AREA_FLICKER_BRIDGE_SECONDS = Math.round(PING_INTERVAL_SECONDS * 1.5);

function parseNaive(str) {
  const [datePart, timePart] = str.split(' ');
  const [y, m, d] = datePart.split('-').map(Number);
  const [hh, mm, ss] = (timePart || '00:00:00').split(':').map(Number);
  return Date.UTC(y, m - 1, d, hh, mm, ss);
}

function addSeconds(naiveStr, seconds) {
  const d = new Date(parseNaive(naiveStr) + seconds * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** pings: [{recorded_at, in_area}] URUT ASC. Balikin segmen antar-ping. */
function buildSegments(pings) {
  const segments = [];
  for (let i = 0; i < pings.length - 1; i++) {
    const cur = pings[i];
    const next = pings[i + 1];
    const gapSeconds = (parseNaive(next.recorded_at) - parseNaive(cur.recorded_at)) / 1000;
    if (gapSeconds <= 0) continue; // data ganda/gak urut, skip
    const capped = gapSeconds > MAX_GAP_SECONDS;
    const duration = capped ? MAX_GAP_SECONDS : gapSeconds;
    segments.push({
      startStr: cur.recorded_at,
      endStr: addSeconds(cur.recorded_at, duration),
      dateKey: cur.recorded_at.slice(0, 10),
      duration_seconds: duration,
      in_area: !!cur.in_area,
      capped,
    });
  }
  return segments;
}

/** Total online / di-dalam-area / di-luar-area per tanggal (YYYY-MM-DD). */
function summarizeByDay(pings) {
  const byDay = new Map();
  for (const seg of buildSegments(pings)) {
    if (!byDay.has(seg.dateKey)) byDay.set(seg.dateKey, { online_seconds: 0, in_area_seconds: 0, out_area_seconds: 0 });
    const b = byDay.get(seg.dateKey);
    b.online_seconds += seg.duration_seconds;
    if (seg.in_area) b.in_area_seconds += seg.duration_seconds;
    else b.out_area_seconds += seg.duration_seconds;
  }
  return byDay;
}

/**
 * Gabung segmen berturutan yang lolos `matchFn(seg)` jadi rentang waktu
 * (start-end). Sesi PUTUS kalau: segmen gak lolos matchFn (mis. keluar
 * area di tengah sesi "di dalam area"), ATAU segmen capped (disconnect
 * -- apapun jenis sesinya, gak nyambung lewat jeda yang gak ada datanya).
 *
 * `bridgeSeconds` (opsional): kalau segmen yang GAK lolos matchFn cuma
 * "keblip" sebentar (total durasi <= bridgeSeconds, gak ada disconnect
 * di tengahnya, DAN abis itu balik lolos matchFn lagi), dianggap noise
 * -- sesi yang lagi jalan tetep nyambung ngelewatin blip itu, gak
 * dianggap sesi baru.
 */
function mergeSessions(segments, matchFn, bridgeSeconds = 0) {
  const sessions = [];
  let current = null;
  let i = 0;
  while (i < segments.length) {
    const seg = segments[i];

    if (matchFn(seg)) {
      if (current) {
        current.end = seg.endStr;
        current.duration_seconds += seg.duration_seconds;
      } else {
        current = { start: seg.startStr, end: seg.endStr, duration_seconds: seg.duration_seconds };
        sessions.push(current);
      }
      if (seg.capped) current = null;
      i++;
      continue;
    }

    // Segmen ini gagal matchFn -- coba cek apakah ini cuma blip singkat
    // yang bisa "dijembatani" (sesi yang lagi jalan tetep dianggap nyambung).
    if (current && bridgeSeconds > 0 && !seg.capped) {
      let j = i;
      let offDuration = 0;
      let hitCapped = false;
      while (j < segments.length && !matchFn(segments[j])) {
        if (segments[j].capped) { hitCapped = true; break; }
        offDuration += segments[j].duration_seconds;
        j++;
      }
      const resumesAfter = !hitCapped && j < segments.length && matchFn(segments[j]);
      if (resumesAfter && offDuration <= bridgeSeconds) {
        current.end = segments[j - 1].endStr;
        current.duration_seconds += offDuration;
        i = j;
        continue;
      }
    }

    current = null;
    i++;
  }
  return sessions;
}

/** Rentang waktu ONLINE (apapun posisinya, dalam ATAU luar area) -- cuma putus kalau disconnect. */
function buildOnlineSessions(pings) {
  return mergeSessions(buildSegments(pings), () => true);
}

/** Rentang waktu online DAN posisinya di dalam area pabrik (blip GPS singkat di-bridge). */
function buildInAreaSessions(pings) {
  return mergeSessions(buildSegments(pings), (seg) => seg.in_area, AREA_FLICKER_BRIDGE_SECONDS);
}

/** Rentang waktu online tapi posisinya di LUAR area pabrik (blip GPS singkat di-bridge). */
function buildOutAreaSessions(pings) {
  return mergeSessions(buildSegments(pings), (seg) => !seg.in_area, AREA_FLICKER_BRIDGE_SECONDS);
}

/**
 * Buang sesi yang durasinya kependekan buat ditampilin satu-satu (biar
 * daftarnya gak kepanjangan/berantakan) -- TOTAL detik di kartu ringkasan
 * TETEP presisi (dari summarizeByDay, gak lewat sini), ini cuma nyaring
 * apa yang muncul di daftar rentang waktunya.
 */
function filterSignificantSessions(sessions, minSeconds = 60) {
  return sessions.filter(s => s.duration_seconds >= minSeconds);
}

module.exports = {
  PING_INTERVAL_SECONDS,
  MAX_GAP_SECONDS,
  AREA_FLICKER_BRIDGE_SECONDS,
  buildSegments,
  summarizeByDay,
  buildOnlineSessions,
  buildInAreaSessions,
  buildOutAreaSessions,
  filterSignificantSessions,
};
