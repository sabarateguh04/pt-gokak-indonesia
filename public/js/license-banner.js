/* Banner peringatan lisensi mau habis (H-30) -- ditaruh di halaman
 * admin yang paling sering dibuka (dashboard). Kalau lisensi udah
 * bener-bener invalid/expired, itu udah ditangani otomatis lewat
 * redirect ke /license-locked (lihat api.js) begitu ada request API
 * yang kena 403 -- banner ini cuma buat "kasih tau lebih awal", bukan
 * satu-satunya jaring pengaman.
 */
(async function () {
  const DISMISS_KEY = 'pt_gokak_license_banner_dismissed_until';
  const dismissedUntil = Number(sessionStorage.getItem(DISMISS_KEY) || 0);
  if (Date.now() < dismissedUntil) return;

  try {
    const res = await fetch('/api/license/status').then(r => r.json());
    if (!res.success || !res.valid || res.days_remaining == null || res.days_remaining > 30) return;

    const bar = document.createElement('div');
    bar.className = 'license-warn-bar';
    const tanggal = res.valid_until ? new Date(res.valid_until).toLocaleDateString('id-ID') : '-';
    bar.innerHTML = `⚠️ Lisensi berakhir dalam <b>${res.days_remaining} hari</b> (${tanggal}). Hubungi vendor untuk perpanjangan.
      <span class="license-warn-close" title="Tutup">✕</span>`;
    bar.querySelector('.license-warn-close').onclick = () => {
      sessionStorage.setItem(DISMISS_KEY, String(Date.now() + 60 * 60 * 1000)); // sembunyi 1 jam
      bar.remove();
    };
    document.body.prepend(bar);
  } catch (e) { /* non-critical, diamkan */ }
})();
