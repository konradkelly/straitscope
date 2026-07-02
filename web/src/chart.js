const ROUTE_COLOR = { northern: '#2a78d6', southern: '#1baf7a', mixed: '#eda100' };
const ROUTE_ORDER = ['northern', 'southern', 'mixed'];
const ROUTE_LABEL = { northern: 'Northern', southern: 'Southern', mixed: 'Mixed' };
const SVG_NS = 'http://www.w3.org/2000/svg';

function aggregateByDay(rows) {
  const byDay = new Map();
  for (const r of rows) {
    const day = String(r.day).slice(0, 10);
    const entry = byDay.get(day) ?? { day, northern: 0, southern: 0, mixed: 0 };
    entry[r.route] = (entry[r.route] ?? 0) + Number(r.transit_count);
    byDay.set(day, entry);
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

export function renderChart(chartEl, tableEl, rows) {
  const data = aggregateByDay(rows);
  renderSvg(chartEl, data);
  renderLegend(chartEl, data);
  renderTable(tableEl, data);
}

function renderSvg(container, data) {
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
  const maxTotal = Math.max(1, ...data.map((d) => d.northern + d.southern + d.mixed));
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
    const presentRoutes = ROUTE_ORDER.filter((r) => d[r] > 0);

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
      rect.setAttribute('fill', ROUTE_COLOR[route]);
      rect.setAttribute('rx', isTop ? '4' : '0');
      rect.style.cursor = 'pointer';

      rect.addEventListener('mousemove', (evt) => {
        const box = container.getBoundingClientRect();
        tooltip.hidden = false;
        tooltip.style.left = `${evt.clientX - box.left}px`;
        tooltip.style.top = `${evt.clientY - box.top}px`;
        tooltip.textContent = `${d.day} · ${ROUTE_LABEL[route]}: ${val}`;
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

function renderLegend(container, data) {
  const legend = document.createElement('div');
  legend.className = 'chart-legend';
  for (const route of ROUTE_ORDER) {
    const item = document.createElement('span');
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = ROUTE_COLOR[route];
    item.append(swatch, document.createTextNode(ROUTE_LABEL[route]));
    legend.appendChild(item);
  }
  container.appendChild(legend);
}

function renderTable(container, data) {
  container.replaceChildren();
  const table = document.createElement('table');
  table.className = 'chart-data';

  const thead = document.createElement('thead');
  thead.innerHTML = '<tr><th>Day</th><th>Northern</th><th>Southern</th><th>Mixed</th><th>Total</th></tr>';
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const d of data) {
    const tr = document.createElement('tr');
    const total = d.northern + d.southern + d.mixed;
    tr.innerHTML = `<td>${d.day}</td><td>${d.northern}</td><td>${d.southern}</td><td>${d.mixed}</td><td>${total}</td>`;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  container.appendChild(table);
}
