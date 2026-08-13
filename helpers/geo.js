/* Helper geofencing sederhana -- point-in-polygon (ray casting), buat
 * nentuin apakah 1 titik GPS teknisi ada DI DALAM salah satu area
 * pabrik (poligon) yang admin gambar di halaman "Area Pabrik".
 *
 * Semua koordinat pakai urutan GeoJSON: [longitude, latitude].
 */

/** Ray casting standar -- ring = array [[lng,lat], ...] (gak perlu ditutup manual). */
function isPointInRing(point, ring) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect = ((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Cek titik [lng,lat] terhadap daftar area { id, polygon } (polygon =
 * ring [[lng,lat],...]). Balikin area PRIMARY pertama yang match, atau
 * { inArea:false, areaId:null } kalau gak ada satupun yang cocok.
 */
function classifyPoint(lng, lat, areas) {
  for (const area of areas || []) {
    const ring = Array.isArray(area.polygon) ? area.polygon : [];
    if (ring.length >= 3 && isPointInRing([lng, lat], ring)) {
      return { inArea: true, areaId: area.id };
    }
  }
  return { inArea: false, areaId: null };
}

module.exports = { isPointInRing, classifyPoint };
