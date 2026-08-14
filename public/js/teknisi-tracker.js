/* GPS tracker sisi teknisi -- jalan selama status ONLINE/ON_TASK.
 * Pakai browser Geolocation API, kirim ping ke server tiap PING_INTERVAL_MS.
 * Dipakai di teknisi/home.html.
 */
const TeknisiTracker = (() => {
  // 30 detik -- sinkron sama helpers/kehadiran.js (PING_INTERVAL_SECONDS).
  // SENGAJA gak dibikin lebih cepat (sempet dicoba 2 detik) -- GPS+network
  // ping sesering itu boros baterai HP teknisi buat manfaat yang gak
  // sebanding, 30 detik udah cukup buat kebutuhan tracking & KPI kehadiran.
  const PING_INTERVAL_MS = 30000;
  let watchId = null;
  let intervalId = null;
  let lastPosition = null;

  function start(teknisiId, onUpdate) {
    if (!navigator.geolocation) {
      console.warn('Geolocation tidak didukung browser ini');
      return;
    }
    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        lastPosition = pos.coords;
        if (onUpdate) onUpdate(pos.coords);
      },
      (err) => console.error('[GEO]', err.message),
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 },
    );

    intervalId = setInterval(() => {
      if (!lastPosition) return;
      Api.post(`/api/teknisi/${teknisiId}/location`, {
        latitude: lastPosition.latitude,
        longitude: lastPosition.longitude,
      });
    }, PING_INTERVAL_MS);
  }

  function stop() {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    if (intervalId !== null) clearInterval(intervalId);
    watchId = null;
    intervalId = null;
    lastPosition = null;
  }

  return { start, stop };
})();
