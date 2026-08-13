/* Peta live monitoring teknisi — 3D, dibatasi cuma area pabrik.
 * Butuh MapLibre GL JS + Api (api.js) udah di-load duluan di halaman.
 *
 * Style peta & tile vector dari OpenFreeMap (gratis, tanpa API key),
 * style "liberty" udah punya layer 3D building bawaan (fill-extrusion)
 * yang otomatis kepake kalau OSM punya data gedungnya. Poligon area
 * pabrik sendiri (digambar admin di halaman "Area Pabrik", tersimpan
 * di tabel pt_kapuk_area) di-extrude manual di atasnya -- itu SUMBER
 * KEBENARAN geofence-nya, bukan cuma dekorasi.
 *
 * FactoryMap.init('map')      -> bikin peta 3D, terkunci di area pabrik
 * FactoryMap.setTeknisi(list) -> render ulang semua marker teknisi (clustered)
 * FactoryMap.resetView()      -> balikin kamera ke posisi default
 */
const FactoryMap = (() => {
  const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
  const DEFAULT_ZOOM = 17.5;
  const DEFAULT_PITCH = 55;
  const DEFAULT_BEARING = -17;

  let map = null;
  let factoryCenter = [106.8408239, -6.380064];

  function statusLabel(status) {
    if (status === 'ONLINE') return 'Online';
    if (status === 'ON_TASK') return 'Sedang bertugas';
    return 'Offline';
  }

  function toGeoJson(list) {
    return {
      type: 'FeatureCollection',
      features: (list || [])
        .filter(t => t.latitude != null && t.longitude != null)
        .map(t => ({
          type: 'Feature',
          properties: {
            id: t.id,
            nama: t.nama,
            jabatan: t.jabatan || '',
            status: t.status,
            tugas_sekarang: t.tugas_sekarang || '',
            last_location_at: t.last_location_at || '',
          },
          geometry: { type: 'Point', coordinates: [t.longitude, t.latitude] },
        })),
    };
  }

  function popupHtml(p) {
    const tugas = p.tugas_sekarang ? `<div>Tugas: <b>${p.tugas_sekarang}</b></div>` : '<div>Tidak ada tugas aktif</div>';
    const lastSeen = p.last_location_at ? new Date(p.last_location_at).toLocaleString('id-ID') : '-';
    return `
      <div class="map-popup">
        <div class="map-popup-title">${p.nama}</div>
        <div class="map-popup-sub">${p.jabatan || ''}</div>
        <div>Status: <b>${statusLabel(p.status)}</b></div>
        ${tugas}
        <div class="map-popup-ts">Update terakhir: ${lastSeen}</div>
        <a href="/admin/tiket?teknisiId=${p.id}">Lihat tiket teknisi ini →</a>
        <a href="/admin/kehadiran?teknisiId=${p.id}">Lihat kehadiran teknisi ini →</a>
      </div>`;
  }

  /** Langit gradasi + pencahayaan lembut buat blok 3D -- biar gedung
   *  keliatan punya kedalaman (ada sisi terang/gelap), bukan blok flat
   *  satu warna doang. Dibungkus try/catch karena 'sky' cuma didukung
   *  MapLibre versi baru -- kalau gagal, peta tetap jalan normal. */
  function addAtmosphere() {
    try {
      map.setLight({ anchor: 'viewport', color: '#ffffff', intensity: 0.35, position: [1.5, 90, 60] });
    } catch (e) { /* versi MapLibre lama, skip */ }
    try {
      map.addLayer({
        id: 'sky',
        type: 'sky',
        paint: { 'sky-type': 'atmosphere', 'sky-atmosphere-sun-intensity': 8, 'sky-atmosphere-color': 'rgba(135, 180, 255, 0.6)' },
      });
    } catch (e) { /* versi MapLibre lama, skip */ }
  }

  /** Titik tengah kasar poligon (rata-rata semua vertex) -- cukup buat
   *  posisi label nama, gak perlu centroid geometris yang presisi. */
  function polygonCentroid(ring) {
    const pts = ring.slice(0, -1); // buang titik penutup (sama kayak titik pertama)
    const lng = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const lat = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    return [lng, lat];
  }

  async function addAreaLayers() {
    let areas = [];
    try {
      const res = await Api.get('/api/area');
      if (res.success) areas = res.area.filter(a => a.is_active);
    } catch (e) { console.error('[MAP] gagal load area', e); }

    const polyFeatures = areas.map(a => ({
      type: 'Feature',
      properties: { id: a.id, nama: a.nama, color: a.color, height: a.height, is_primary: !!a.is_primary },
      geometry: { type: 'Polygon', coordinates: [a.polygon] },
    }));
    const labelFeatures = areas.map(a => ({
      type: 'Feature',
      properties: { nama: a.nama, is_primary: !!a.is_primary },
      geometry: { type: 'Point', coordinates: polygonCentroid(a.polygon) },
    }));

    map.addSource('factory-areas', { type: 'geojson', data: { type: 'FeatureCollection', features: polyFeatures } });
    map.addLayer({
      id: 'factory-areas-3d',
      type: 'fill-extrusion',
      source: 'factory-areas',
      paint: {
        'fill-extrusion-color': ['get', 'color'],
        'fill-extrusion-height': ['get', 'height'],
        'fill-extrusion-base': 0,
        'fill-extrusion-opacity': 0.85,
        'fill-extrusion-vertical-gradient': true,
      },
    });
    map.addLayer({
      id: 'factory-areas-outline',
      type: 'line',
      source: 'factory-areas',
      filter: ['==', ['get', 'is_primary'], true],
      paint: { 'line-color': '#ffffff', 'line-width': 1.5, 'line-opacity': 0.6 },
    });

    // Pin nama area -- biar keliatan area mana yang mana pas dilihat dari
    // atas peta 3D, gak cuma warna blok doang.
    map.addSource('factory-area-labels', { type: 'geojson', data: { type: 'FeatureCollection', features: labelFeatures } });
    map.addLayer({
      id: 'factory-area-labels',
      type: 'symbol',
      source: 'factory-area-labels',
      layout: {
        'text-field': ['concat', '📍 ', ['get', 'nama']],
        'text-size': 12.5,
        'text-font': ['Noto Sans Bold'],
        'text-allow-overlap': false,
      },
      paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(15,23,42,.85)', 'text-halo-width': 1.4 },
    });

    map.on('click', 'factory-areas-3d', (e) => {
      const p = e.features[0].properties;
      new maplibregl.Popup({ offset: 10 })
        .setLngLat(e.lngLat)
        .setHTML(`<div class="map-popup"><div class="map-popup-title">${p.nama}</div><div class="map-popup-sub">${p.is_primary ? 'Area primary (dihitung KPI)' : 'Area referensi'}</div></div>`)
        .addTo(map);
    });
    ['factory-areas-3d', 'factory-area-labels'].forEach((layer) => {
      map.on('mouseenter', layer, () => map.getCanvas().style.cursor = 'pointer');
      map.on('mouseleave', layer, () => map.getCanvas().style.cursor = '');
    });
  }

  function addTeknisiLayers() {
    map.addSource('teknisi', {
      type: 'geojson',
      data: toGeoJson([]),
      cluster: true,
      clusterMaxZoom: 19,
      clusterRadius: 45,
    });

    map.addLayer({
      id: 'teknisi-cluster',
      type: 'circle',
      source: 'teknisi',
      filter: ['has', 'point_count'],
      paint: {
        'circle-color': '#3b82f6',
        'circle-radius': ['step', ['get', 'point_count'], 16, 5, 20, 10, 26, 50, 32],
        'circle-stroke-width': 2,
        'circle-stroke-color': '#0f172a',
      },
    });
    map.addLayer({
      id: 'teknisi-cluster-count',
      type: 'symbol',
      source: 'teknisi',
      filter: ['has', 'point_count'],
      layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-size': 12, 'text-font': ['Noto Sans Bold'] },
      paint: { 'text-color': '#fff' },
    });

    // Halo lembut di belakang tiap titik teknisi -- kesan "menyala" buat
    // yang online/bertugas, tanpa perlu animasi berat.
    map.addLayer({
      id: 'teknisi-point-glow',
      type: 'circle',
      source: 'teknisi',
      filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-color': ['match', ['get', 'status'], 'ONLINE', '#22c55e', 'ON_TASK', '#f59e0b', '#64748b'],
        'circle-radius': 18,
        'circle-blur': 1,
        'circle-opacity': 0.35,
      },
    });
    map.addLayer({
      id: 'teknisi-point',
      type: 'circle',
      source: 'teknisi',
      filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-color': [
          'match', ['get', 'status'],
          'ONLINE', '#22c55e',
          'ON_TASK', '#f59e0b',
          '#64748b',
        ],
        'circle-radius': 9,
        'circle-stroke-width': 2,
        'circle-stroke-color': '#0f172a',
      },
    });
    map.addLayer({
      id: 'teknisi-label',
      type: 'symbol',
      source: 'teknisi',
      filter: ['!', ['has', 'point_count']],
      layout: {
        'text-field': ['get', 'nama'],
        'text-size': 11,
        'text-offset': [0, 1.4],
        'text-anchor': 'top',
        'text-font': ['Noto Sans Regular'],
        'text-optional': true,
      },
      paint: { 'text-color': '#e2e8f0', 'text-halo-color': '#0f172a', 'text-halo-width': 1.2 },
    });

    map.on('click', 'teknisi-cluster', (e) => {
      const features = map.queryRenderedFeatures(e.point, { layers: ['teknisi-cluster'] });
      const clusterId = features[0].properties.cluster_id;
      map.getSource('teknisi').getClusterExpansionZoom(clusterId, (err, zoom) => {
        if (err) return;
        map.easeTo({ center: features[0].geometry.coordinates, zoom });
      });
    });

    map.on('click', 'teknisi-point', (e) => {
      const f = e.features[0];
      new maplibregl.Popup({ offset: 14 })
        .setLngLat(f.geometry.coordinates)
        .setHTML(popupHtml(f.properties))
        .addTo(map);
    });

    ['teknisi-point', 'teknisi-cluster'].forEach((layer) => {
      map.on('mouseenter', layer, () => map.getCanvas().style.cursor = 'pointer');
      map.on('mouseleave', layer, () => map.getCanvas().style.cursor = '');
    });
  }

  async function init(elementId) {
    try {
      const cfg = await fetch('/api/config').then(r => r.json());
      if (cfg?.factoryCenter) factoryCenter = [cfg.factoryCenter.lng, cfg.factoryCenter.lat];
    } catch (e) { /* fallback ke koordinat default di atas */ }

    // Radius kunci area (derajat) -- peta gak bisa di-pan/zoom-out keluar
    // dari kotak ini, biar fokusnya "khusus area situ aja".
    const pad = 0.006;
    const bounds = [
      [factoryCenter[0] - pad, factoryCenter[1] - pad],
      [factoryCenter[0] + pad, factoryCenter[1] + pad],
    ];

    map = new maplibregl.Map({
      container: elementId,
      style: STYLE_URL,
      center: factoryCenter,
      zoom: DEFAULT_ZOOM,
      pitch: DEFAULT_PITCH,
      bearing: DEFAULT_BEARING,
      maxBounds: bounds,
      minZoom: 15.5,
      maxZoom: 20,
      antialias: true,
    });

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');

    return new Promise((resolve) => {
      map.on('load', async () => {
        addAtmosphere();
        await addAreaLayers();
        addTeknisiLayers();
        resolve(map);
      });
    });
  }

  function setTeknisi(list) {
    const src = map?.getSource('teknisi');
    if (src) src.setData(toGeoJson(list));
  }

  function resetView() {
    map.easeTo({ center: factoryCenter, zoom: DEFAULT_ZOOM, pitch: DEFAULT_PITCH, bearing: DEFAULT_BEARING, duration: 800 });
  }

  function resize() { map?.resize(); }

  return { init, setTeknisi, resetView, resize };
})();
