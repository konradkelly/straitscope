export function renderHeadline(data) {
  document.querySelector('#stat-today .stat-value').textContent = data.today_transits;
  document.querySelector('#stat-avg .stat-value').textContent = data.seven_day_avg;

  const { northern, southern } = data.route_split_pct;
  document.querySelector('#stat-split .stat-value').innerHTML =
    `<span class="split-n">${northern}%</span> N / <span class="split-s">${southern}%</span> S`;

  document.querySelector('#stat-dark .stat-value').textContent = data.dark_vessel_count_24h;
}
