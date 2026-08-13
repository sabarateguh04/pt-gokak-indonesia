/* Dark/Terang mode -- satu file dipake semua halaman.
 *
 * PENTING: script ini SENGAJA di-load sebagai baris <script> PERTAMA
 * di <head>, SEBELUM link stylesheet, biar tema ke-apply ke
 * <html data-theme="..."> sebelum browser mulai ngecat halaman (biar
 * gak ada "flash" warna tema lama sekilas pas halaman baru dibuka).
 *
 * Default kalau belum pernah pilih: ikutin preferensi OS/browser
 * (prefers-color-scheme), fallback ke dark kalau gak kedeteksi.
 */
(function applyStoredTheme() {
  const stored = localStorage.getItem('pt_gokak_theme');
  const theme = stored || (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  document.documentElement.setAttribute('data-theme', theme);
})();

function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('pt_gokak_theme', next);
  document.querySelectorAll('.theme-toggle-icon').forEach(el => { el.textContent = next === 'dark' ? '🌙' : '☀️'; });
  return next;
}

/* Panggil ini setelah DOM siap buat pasang ikon awal yang bener (tanpa
 * ini ikon default di HTML dianggap benar terus, padahal tema bisa aja
 * udah 'light' dari localStorage). */
function initThemeToggle() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  document.querySelectorAll('.theme-toggle-icon').forEach(el => { el.textContent = current === 'dark' ? '🌙' : '☀️'; });
  document.querySelectorAll('.theme-toggle-btn').forEach(btn => { btn.onclick = toggleTheme; });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initThemeToggle);
} else {
  initThemeToggle();
}
