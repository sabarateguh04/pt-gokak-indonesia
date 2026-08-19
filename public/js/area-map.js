/* Peta 3D buat halaman "Area Pabrik" -- admin gambar poligon area
 * dengan klik titik demi titik di atas peta beneran (lokasi asli),
 * bukan ketik koordinat manual. Butuh MapLibre GL JS + Api sudah
 * di-load duluan.
 *
 * AreaMap.init('map')            -> peta 3D di lokasi pabrik/kantor
 * AreaMap.loadAreas()            -> fetch & render semua area tersimpan
 * AreaMap.startDraw()            -> mulai mode gambar (klik peta nambah titik)
 * AreaMap.undoPoint() / clearDraw()
 * AreaMap.finishDraw() -> [[lng,lat], ...] atau null kalau < 3 titik
 * AreaMap.loadPolygonForEdit(polygon) -> isi ulang titik gambar dari area lama
 * AreaMap.flyToPolygon(polygon)
 */
const AreaMap = (() => {
  const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
  let map = null;
  let drawing = false;
  let points = []; // [[lng,lat], ...]
  let onPointsChange = null;

  function ring(pts) { return pts.length >= 2 ? [...pts, pts[0]] : pts; }

  function drawFeatures() {
    const features = [];
    points.forEach((p, i) => features.push({
      type: 'Feature', properties: { idx: i }, geometry: { type: 'Point', coordinates: p },
    }));
    if (points.length >= 2) {
      features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: ring(points) } });
    }
    if (points.length >= 3) {
      features.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring(points)] } });
    }
    return { type: 'FeatureCollection', features };
  }

  function refreshDraw() {
    const src = map.getSource('draw');
    if (src) src.setData(drawFeatures());
    if (onPointsChange) onPointsChange(points.length);
  }

  async function init(elementId, opts = {}) {
    let center = [106.8958, -6.4718];
    try {
      const cfg = await fetch('/api/config').then(r => r.json());
      if (cfg?.factoryCenter) center = [cfg.factoryCenter.lng, cfg.factoryCenter.lat];
    } catch (e) { /* pakai default */ }

    onPointsChange = opts.onPointsChange || null;

    const pad = 0.015;
    map = new maplibregl.Map({
      container: elementId,
      style: STYLE_URL,
      center,
      zoom: 17,
      pitch: 50,
      bearing: -10,
      maxBounds: [[center[0] - pad, center[1] - pad], [center[0] + pad, center[1] + pad]],
      minZoom: 14,
      maxZoom: 20,
      antialias: true,
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');

    await new Promise((resolve) => map.on('load', resolve));

    try { map.setLight({ anchor: 'viewport', color: '#ffffff', intensity: 0.35, position: [1.5, 90, 60] }); } catch (e) { /* versi lama */ }
    try {
      map.addLayer({ id: 'sky', type: 'sky', paint: { 'sky-type': 'atmosphere', 'sky-atmosphere-sun-intensity': 8, 'sky-atmosphere-color': 'rgba(135, 180, 255, 0.6)' } });
    } catch (e) { /* versi lama */ }

    try {
      map.addSource('kml-data', { type: 'geojson', data: '/data/layout.geojson' });
      map.addLayer({
        id: 'kml-fill', type: 'fill', source: 'kml-data',
        paint: {
          'fill-color': ['coalesce', ['get', 'fill'], '#ff0000'],
          'fill-opacity': ['coalesce', ['get', 'fill-opacity'], 0.65],
        },
      });
      map.addLayer({
        id: 'kml-outline', type: 'line', source: 'kml-data',
        paint: { 'line-color': ['coalesce', ['get', 'stroke'], '#ffffff'], 'line-width': 1.5, 'line-opacity': 0.8 },
      });
      map.addLayer({
        id: 'kml-labels', type: 'symbol', source: 'kml-data',
        layout: { 'text-field': ['get', 'name'], 'text-size': 11.5, 'text-font': ['Noto Sans Bold'], 'text-allow-overlap': false },
        paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(15,23,42,.85)', 'text-halo-width': 1.4 },
      });
    } catch (e) { console.error('[AREA MAP] gagal load layout.geojson', e); }

    map.addSource('existing-areas', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'existing-areas-3d', type: 'fill-extrusion', source: 'existing-areas',
      paint: {
        'fill-extrusion-color': ['get', 'color'], 'fill-extrusion-height': ['get', 'height'],
        'fill-extrusion-base': 0, 'fill-extrusion-opacity': 0.7, 'fill-extrusion-vertical-gradient': true,
      },
    });
    map.addLayer({
      id: 'existing-areas-outline', type: 'line', source: 'existing-areas',
      paint: { 'line-color': '#ffffff', 'line-width': 1.2, 'line-opacity': 0.5 },
    });
    map.addSource('existing-area-labels', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'existing-area-labels', type: 'symbol', source: 'existing-area-labels',
      layout: { 'text-field': ['concat', '📍 ', ['get', 'nama']], 'text-size': 12.5, 'text-font': ['Noto Sans Bold'], 'text-allow-overlap': false },
      paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(15,23,42,.85)', 'text-halo-width': 1.4 },
    });

    map.addSource('draw', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'draw-fill', type: 'fill', source: 'draw', paint: { 'fill-color': '#4f7cff', 'fill-opacity': 0.25 } });
    map.addLayer({ id: 'draw-line', type: 'line', source: 'draw', paint: { 'line-color': '#4f7cff', 'line-width': 2.5, 'line-dasharray': [1, 1] } });
    map.addLayer({ id: 'draw-points', type: 'circle', source: 'draw', paint: { 'circle-radius': 5, 'circle-color': '#fff', 'circle-stroke-width': 2, 'circle-stroke-color': '#4f7cff' } });

    map.on('click', (e) => {
      if (!drawing) return;
      // Kalau klik dekat sama titik pertama (>=3 titik) -> tutup poligon, gak nambah titik dobel
      points.push([e.lngLat.lng, e.lngLat.lat]);
      refreshDraw();
    });

    return map;
  }

  function centroid(ring) {
    const pts = ring.slice(0, -1);
    return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
  }

  async function loadAreas() {
    const res = await Api.get('/api/area');
    if (!res.success) return [];
    const active = res.area.filter(a => a.is_active);
    const features = active.map(a => ({
      type: 'Feature',
      properties: { id: a.id, nama: a.nama, color: a.color, height: a.height, is_primary: !!a.is_primary },
      geometry: { type: 'Polygon', coordinates: [a.polygon] },
    }));
    const labelFeatures = active.map(a => ({
      type: 'Feature', properties: { nama: a.nama }, geometry: { type: 'Point', coordinates: centroid(a.polygon) },
    }));
    map.getSource('existing-areas').setData({ type: 'FeatureCollection', features });
    map.getSource('existing-area-labels').setData({ type: 'FeatureCollection', features: labelFeatures });
    return res.area;
  }

  function startDraw() { drawing = true; points = []; refreshDraw(); }
  function stopDraw() { drawing = false; }
  function undoPoint() { points.pop(); refreshDraw(); }
  function clearDraw() { points = []; refreshDraw(); }
  function finishDraw() { drawing = false; return points.length >= 3 ? [...points] : null; }
  function loadPolygonForEdit(polygon) {
    // polygon tersimpan tertutup (titik pertama = terakhir) -- buang duplikat penutup
    points = polygon.slice(0, -1);
    drawing = true;
    refreshDraw();
    flyToPolygon(polygon);
  }
  function flyToPolygon(polygon) {
    const lngs = polygon.map(p => p[0]);
    const lats = polygon.map(p => p[1]);
    map.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]], { padding: 60, duration: 600 });
  }

  return { init, loadAreas, startDraw, stopDraw, undoPoint, clearDraw, finishDraw, loadPolygonForEdit, flyToPolygon };
})();
