/* Kalender heatmap ala kontribusi GitHub -- buat nunjukin "seberapa
 * penuh" karyawan online per hari (progress bulanan/tahunan sekali
 * lihat). Pure DOM, gak ada dependency.
 *
 * CalendarHeatmap.render(container, days, opts)
 *   days: [{ date:'YYYY-MM-DD', online_seconds, in_area_seconds, out_area_seconds }, ...]
 *         (urutan bebas, otomatis di-sort & dilengkapi tanggal kosong)
 *   opts: { valueKey:'online_seconds' (default), onClickDay(date, dayData) }
 */
const CalendarHeatmap = (() => {
  const WEEKDAY_LABEL = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
  const MONTH_LABEL = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

  // Threshold FIXED (bukan relatif ke data) -- biar "warna gelap" artinya
  // konsisten lintas karyawan/hari: patokan hari kerja ~8 jam.
  function levelFor(seconds) {
    if (!seconds) return 0;
    if (seconds <= 2 * 3600) return 1;
    if (seconds <= 4 * 3600) return 2;
    if (seconds <= 6 * 3600) return 3;
    return 4;
  }

  function fmtHours(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds % 3600) / 60);
    if (h === 0 && m === 0) return '0 menit';
    return [h ? `${h} jam` : null, m ? `${m} menit` : null].filter(Boolean).join(' ');
  }

  function render(container, days, opts = {}) {
    const valueKey = opts.valueKey || 'online_seconds';
    const byDate = new Map((days || []).map(d => [d.date, d]));
    const sorted = [...byDate.keys()].sort();
    if (!sorted.length) { container.innerHTML = '<div class="empty-state">Belum ada data</div>'; return; }

    const firstDate = new Date(sorted[0] + 'T00:00:00Z');
    const lastDate = new Date(sorted[sorted.length - 1] + 'T00:00:00Z');

    // Mundurin ke hari Minggu terdekat SEBELUM/SAMA firstDate, biar kolom
    // minggu align rapi (baris 1 = Minggu, baris 7 = Sabtu) kayak GitHub.
    const gridStart = new Date(firstDate);
    gridStart.setUTCDate(gridStart.getUTCDate() - gridStart.getUTCDay());

    const weeks = [];
    let cursor = new Date(gridStart);
    while (cursor <= lastDate) {
      const week = [];
      for (let d = 0; d < 7; d++) {
        const key = cursor.toISOString().slice(0, 10);
        week.push({ date: key, data: byDate.get(key) || null, dow: d, monthOfCell: cursor.getUTCMonth() });
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
      weeks.push(week);
    }

    container.innerHTML = '';
    container.classList.add('cal-heatmap');

    // Struktur: [kolom label hari] [area-scroll: [baris label bulan][grid minggu]]
    // -- label bulan & grid HARUS sama-sama di dalam area-scroll biar
    // kolomnya align pas di-scroll horizontal; kolom label hari di luar
    // scroll (statis), dikasih spacer setinggi baris label bulan.
    const monthRow = document.createElement('div');
    monthRow.className = 'cal-month-row';
    const grid = document.createElement('div');
    grid.className = 'cal-grid';

    let lastMonthLabeled = -1;
    weeks.forEach((week) => {
      const col = document.createElement('div');
      col.className = 'cal-week';

      const firstCellMonth = week[0].monthOfCell;
      const label = document.createElement('div');
      label.className = 'cal-month-label';
      if (firstCellMonth !== lastMonthLabeled) {
        label.textContent = MONTH_LABEL[firstCellMonth];
        lastMonthLabeled = firstCellMonth;
      }
      monthRow.appendChild(label);

      week.forEach((cell) => {
        const div = document.createElement('div');
        const inRange = cell.date >= sorted[0] && cell.date <= sorted[sorted.length - 1];
        const seconds = cell.data ? (cell.data[valueKey] || 0) : 0;
        const level = inRange ? levelFor(seconds) : 0;
        div.className = `cal-day cal-day-level-${level}`;
        if (inRange) {
          const online = cell.data ? fmtHours(cell.data.online_seconds || 0) : '0 menit';
          const inArea = cell.data ? fmtHours(cell.data.in_area_seconds || 0) : '0 menit';
          const outArea = cell.data ? fmtHours(cell.data.out_area_seconds || 0) : '0 menit';
          div.title = `${cell.date}\nOnline: ${online}\nDi area: ${inArea}\nDi luar area: ${outArea}`;
          div.onclick = () => opts.onClickDay && opts.onClickDay(cell.date, cell.data);
        } else {
          div.style.visibility = 'hidden';
        }
        col.appendChild(div);
      });
      grid.appendChild(col);
    });

    const weekdaySpacer = document.createElement('div');
    weekdaySpacer.className = 'cal-month-row';
    const weekdayCol = document.createElement('div');
    weekdayCol.className = 'cal-weekday-col';
    WEEKDAY_LABEL.forEach((label, i) => {
      const el = document.createElement('div');
      el.className = 'cal-weekday-label';
      el.textContent = i % 2 === 1 ? label : ''; // biar gak terlalu padat, selang-seling
      weekdayCol.appendChild(el);
    });
    const weekdayWrap = document.createElement('div');
    weekdayWrap.appendChild(weekdaySpacer);
    weekdayWrap.appendChild(weekdayCol);

    const scrollWrap = document.createElement('div');
    scrollWrap.className = 'cal-scroll';
    const scrollInner = document.createElement('div');
    scrollInner.appendChild(monthRow);
    scrollInner.appendChild(grid);
    scrollWrap.appendChild(scrollInner);

    const body = document.createElement('div');
    body.className = 'cal-body';
    body.appendChild(weekdayWrap);
    body.appendChild(scrollWrap);

    container.appendChild(body);

    const legend = document.createElement('div');
    legend.className = 'cal-legend';
    legend.innerHTML = `<span>Sedikit</span>${[0, 1, 2, 3, 4].map(l => `<span class="cal-day cal-day-level-${l}" style="display:inline-block"></span>`).join('')}<span>Banyak</span>`;
    container.appendChild(legend);

    // Scroll otomatis ke kanan (hari-hari terbaru) begitu render selesai
    scrollWrap.scrollLeft = scrollWrap.scrollWidth;
  }

  return { render, fmtHours };
})();
