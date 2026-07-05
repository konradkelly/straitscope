// Known route names get a fixed, meaningful color; anything else (a region's
// own corridor vocabulary, e.g. singapore's 'unclassified') falls back to
// this rotating palette so the chart still renders sensibly.
const KNOWN_ROUTE_COLOR = { northern: '#2a78d6', southern: '#1baf7a', mixed: '#eda100' };
const FALLBACK_PALETTE = ['#eda100', '#7a5ea8', '#d0596b', '#3aa6a0'];
const SVG_NS = 'http://www.w3.org/2000/svg';

function routeLabel(route) {
  return route.charAt(0).toUpperCase() + route.slice(1);
}

function aggregateByDay(rows) {
  const routes = [...new Set(rows.map((r) => r.route))];
  const byDay = new Map();
  for (const r of rows) {
    const day = String(r.day).slice(0, 10);
    const entry = byDay.get(day) ?? Object.fromEntries([['day', day], ...routes.map((rt) => [rt, 0])]);
    entry[r.route] = (entry[r.route] ?? 0) + Number(r.transit_count);
    byDay.set(day, entry);
  }
  return { data: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)), routes };
}

export function renderChart(chartEl, tableEl, rows) {
  const { data, routes } = aggregateByDay(rows);
  const routeColor = Object.fromEntries(
    routes.map((r, i) => [r, KNOWN_ROUTE_COLOR[r] ?? FALLBACK_PALETTE[i % FALLBACK_PALETTE.length]])
  );
  renderSvg(chartEl, data, routes, routeColor);
  renderLegend(chartEl, routes, routeColor);
  renderTable(tableEl, data, routes);
}

function renderSvg(container, data, routes, routeColor) {
  container.querySelectorAll('svg, .chart-tooltip, .chart-legend').forEach((el) => el.remove());

  if (data.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'chart-empty';
    empty.textContent = 'No transits recorded yet.';
    container.appendChild(empty);
    return;
  }

  const width = Math.max(container.clientWidth || 640, 320);
  const height = 260;
  const marginTop = 10;
  const marginBottom = 26;
  const plotH = height - marginTop - marginBottom;
  const maxTotal = Math.max(1, ...data.map((d) => routes.reduce((sum, r) => sum + d[r], 0)));
  const barSlot = width / data.length;
  const barW = Math.min(24, Math.max(2, barSlot - 2));

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', String(height));
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Daily transit counts by route, stacked bar chart');

  // baseline
  const baseline = document.createElementNS(SVG_NS, 'line');
  baseline.setAttribute('x1', '0');
  baseline.setAttribute('x2', String(width));
  baseline.setAttribute('y1', String(plotH + marginTop));
  baseline.setAttribute('y2', String(plotH + marginTop));
  baseline.setAttribute('stroke', 'var(--baseline)');
  baseline.setAttribute('stroke-width', '1');
  svg.appendChild(baseline);

  // y-axis ticks: 0 / half / max
  for (const frac of [0, 0.5, 1]) {
    const y = plotH + marginTop - frac * plotH;
    const label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('x', '2');
    label.setAttribute('y', String(y - 3));
    label.textContent = String(Math.round(maxTotal * frac));
    svg.appendChild(label);
  }

  const tooltip = document.createElement('div');
  tooltip.className = 'chart-tooltip';
  tooltip.hidden = true;
  container.style.position = 'relative';

  data.forEach((d, i) => {
    const x = i * barSlot + (barSlot - barW) / 2;
    let yCursor = plotH + marginTop;
    const presentRoutes = routes.filter((r) => d[r] > 0);

    presentRoutes.forEach((route, ri) => {
      const val = d[route];
      const segH = (val / maxTotal) * plotH;
      const isTop = ri === presentRoutes.length - 1;
      const drawH = Math.max(0, segH - (presentRoutes.length > 1 ? 2 : 0));

      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('x', String(x));
      rect.setAttribute('y', String(yCursor - segH));
      rect.setAttribute('width', String(barW));
      rect.setAttribute('height', String(drawH));
      rect.setAttribute('fill', routeColor[route]);
      rect.setAttribute('rx', isTop ? '4' : '0');
      rect.style.cursor = 'pointer';

      rect.addEventListener('mousemove', (evt) => {
        const box = container.getBoundingClientRect();
        tooltip.hidden = false;
        tooltip.style.left = `${evt.clientX - box.left}px`;
        tooltip.style.top = `${evt.clientY - box.top}px`;
        tooltip.textContent = `${d.day} · ${routeLabel(route)}: ${val}`;
      });
      rect.addEventListener('mouseleave', () => {
        tooltip.hidden = true;
      });

      svg.appendChild(rect);
      yCursor -= segH;
    });
  });

  // sparse x-axis date labels (~6 across the width)
  const labelEvery = Math.max(1, Math.ceil(data.length / 6));
  data.forEach((d, i) => {
    if (i % labelEvery !== 0 && i !== data.length - 1) return;
    const label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('x', String(i * barSlot + barSlot / 2));
    label.setAttribute('y', String(height - 6));
    label.setAttribute('text-anchor', 'middle');
    label.textContent = d.day.slice(5); // MM-DD
    svg.appendChild(label);
  });

  container.append(svg, tooltip);
}

function renderLegend(container, routes, routeColor) {
  const legend = document.createElement('div');
  legend.className = 'chart-legend';
  for (const route of routes) {
    const item = document.createElement('span');
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = routeColor[route];
    item.append(swatch, document.createTextNode(routeLabel(route)));
    legend.appendChild(item);
  }
  container.appendChild(legend);
}

function renderTable(container, data, routes) {
  container.replaceChildren();
  const table = document.createElement('table');
  table.className = 'chart-data';

  const thead = document.createElement('thead');
  const headCells = ['Day', ...routes.map(routeLabel), 'Total'].map((h) => `<th>${h}</th>`).join('');
  thead.innerHTML = `<tr>${headCells}</tr>`;
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const d of data) {
    const tr = document.createElement('tr');
    const total = routes.reduce((sum, r) => sum + d[r], 0);
    const cells = [d.day, ...routes.map((r) => d[r]), total].map((v) => `<td>${v}</td>`).join('');
    tr.innerHTML = cells;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  container.appendChild(table);
}
