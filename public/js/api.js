/* Wrapper fetch + penyimpanan token, dipakai bersama oleh portal admin
 * dan portal teknisi. Dua portal itu SENGAJA disimpan di localStorage
 * key yang beda ('pt_gokak_admin' vs 'pt_gokak_teknisi') supaya login
 * admin & login teknisi gak saling menimpa kalau kebuka di browser yang
 * sama (misal admin buka portal teknisi buat testing).
 *
 * Pemakaian di tiap halaman:
 *   Api.init('admin');            // atau 'teknisi' -- taruh paling atas
 *   const me = Api.getUser();     // { id, nama, ... } atau null
 *   const res = await Api.get('/api/tiket');
 *   const res = await Api.post('/api/tiket', { judul: '...' });
 *   await Api.upload('/api/tiket/5/files', formData);
 */
const Api = (() => {
  let scope = 'admin'; // 'admin' | 'teknisi'

  function storageKey(suffix) {
    return `pt_gokak_${scope}_${suffix}`;
  }

  function loginPath() {
    return `/${scope}/login`;
  }

  function init(scopeName) {
    scope = scopeName;
    // Halaman selain login wajib punya token, kalau enggak tendang ke login.
    const isLoginPage = window.location.pathname.replace(/\/$/, '').endsWith('/login');
    if (!isLoginPage && !getToken()) {
      window.location.href = loginPath();
    }
  }

  function getToken() { return localStorage.getItem(storageKey('token')); }

  function getUser() {
    const raw = localStorage.getItem(storageKey('user'));
    return raw ? JSON.parse(raw) : null;
  }

  function setSession(token, user) {
    localStorage.setItem(storageKey('token'), token);
    localStorage.setItem(storageKey('user'), JSON.stringify(user));
  }

  function logout() {
    localStorage.removeItem(storageKey('token'));
    localStorage.removeItem(storageKey('user'));
    window.location.href = loginPath();
  }

  async function request(method, path, body) {
    const headers = { Authorization: `Bearer ${getToken() || ''}` };
    let payload = body;
    if (body && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(path, { method, headers, body: payload });
    if (res.status === 401) {
      logout();
      return { success: false, message: 'Sesi habis' };
    }
    return res.json();
  }

  return {
    init,
    getToken,
    getUser,
    setSession,
    logout,
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body || {}),
    put: (path, body) => request('PUT', path, body || {}),
    del: (path) => request('DELETE', path),
    upload: (path, formData) => request('POST', path, formData),
  };
})();
