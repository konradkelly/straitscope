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
}
