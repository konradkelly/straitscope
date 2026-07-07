// Route vocabulary is region-specific (hormuz: northern/southern/mixed;
// singapore: unclassified) — render whatever routes the API actually
// reports rather than assuming Hormuz's northern/southern split.
function formatSplit(routeSplitPct) {
  const entries = Object.entries(routeSplitPct);
  if (entries.length === 0) return '—';
  return entries
    .map(([route, pct]) => `<span class="split-${route}">${pct}% ${route.charAt(0).toUpperCase()}</span>`)
    .join(' / ');
}

export function renderHeadline(data) {
  document.querySelector('#stat-today .stat-value').textContent = data.today_transits;
  document.querySelector('#stat-avg .stat-value').textContent = data.seven_day_avg;

  document.querySelector('#stat-split .stat-value').innerHTML = formatSplit(data.route_split_pct);

  document.querySelector('#stat-dark .stat-value').textContent = data.dark_vessel_count_24h;

  renderVesselMix(data.vessel_type_counts ?? {});
}

// Fixed categorical order/colors, matching the map's vessel-dot coloring
// (SHIP_TYPE_COLOR in map.js) so "tanker" means the same hue everywhere.
const SHIP_TYPE_ORDER = ['tanker', 'cargo', 'other'];
const SHIP_TYPE_COLOR_VAR = { tanker: 'var(--series-1)', cargo: 'var(--series-2)', other: 'var(--series-3)' };
const SHIP_TYPE_LABEL = { tanker: 'Tanker', cargo: 'Cargo', other: 'Other' };

function renderVesselMix(counts) {
  const tile = document.querySelector('#stat-vessel-mix');
  const bar = tile.querySelector('.vessel-mix-bar');
  const legend = tile.querySelector('.vessel-mix-legend');
  bar.replaceChildren();
  legend.replaceChildren();

  const present = SHIP_TYPE_ORDER.filter((t) => (counts[t] ?? 0) > 0);
  const total = present.reduce((sum, t) => sum + counts[t], 0);

  if (total === 0) {
    const empty = document.createElement('span');
    empty.className = 'vessel-mix-empty';
    empty.textContent = 'No vessels seen';
    bar.appendChild(empty);
    return;
  }

  const tooltip = document.createElement('div');
  tooltip.className = 'chart-tooltip';
  tooltip.hidden = true;

  for (const type of present) {
    const n = counts[type];
    const pct = Math.round((n / total) * 1000) / 10;
    const label = `${SHIP_TYPE_LABEL[type]}: ${n} (${pct}%)`;

    const seg = document.createElement('div');
    seg.className = 'vessel-mix-seg';
    seg.style.flex = `${n} 0 0`;
    seg.style.background = SHIP_TYPE_COLOR_VAR[type];
    seg.tabIndex = 0;
    seg.setAttribute('role', 'img');
    seg.setAttribute('aria-label', label);

    const show = (evt) => {
      const box = bar.getBoundingClientRect();
      tooltip.hidden = false;
      tooltip.style.left = evt ? `${evt.clientX - box.left}px` : `${seg.offsetLeft + seg.offsetWidth / 2}px`;
      tooltip.style.top = '0px';
      tooltip.textContent = label;
    };
    const hide = () => {
      tooltip.hidden = true;
    };
    seg.addEventListener('mousemove', show);
    seg.addEventListener('focus', () => show());
    seg.addEventListener('mouseleave', hide);
    seg.addEventListener('blur', hide);

    bar.appendChild(seg);
  }
  bar.appendChild(tooltip);

  for (const type of present) {
    const n = counts[type];
    const pct = Math.round((n / total) * 1000) / 10;
    const item = document.createElement('span');
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = SHIP_TYPE_COLOR_VAR[type];
    item.append(swatch, document.createTextNode(`${SHIP_TYPE_LABEL[type]} ${pct}%`));
    legend.appendChild(item);
  }
}
