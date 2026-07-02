import { fetchLive, fetchDaily, fetchHeadline, fetchIncidents } from './api.js';
import { initMap, setVessels, setIncidents, toggleLayer } from './map.js';
import { renderChart } from './chart.js';
import { renderIncidents } from './incidents.js';
import { renderHeadline } from './headline.js';
import './style.css';

const DISCLAIMER_KEY = 'straittracker-disclaimer-dismissed';
const LIVE_REFRESH_MS = 30_000;
const HEADLINE_REFRESH_MS = 5 * 60_000;

function initBanner() {
  const banner = document.querySelector('#disclaimer-banner');
  const dismissBtn = document.querySelector('#banner-dismiss');
  if (!localStorage.getItem(DISCLAIMER_KEY)) {
    banner.hidden = false;
  }
  dismissBtn.addEventListener('click', () => {
    banner.hidden = true;
    localStorage.setItem(DISCLAIMER_KEY, '1');
  });
}

function initTableToggle() {
  const btn = document.querySelector('#chart-table-toggle');
  const chart = document.querySelector('#chart');
  const table = document.querySelector('#chart-table');
  btn.addEventListener('click', () => {
    const switchingToTable = table.hidden;
    table.hidden = !switchingToTable;
    chart.hidden = switchingToTable;
    btn.textContent = switchingToTable ? 'View as chart' : 'View as table';
  });
}

function initMapToggles(map) {
  document.querySelector('#toggle-corridors').addEventListener('change', (e) => {
    toggleLayer(map, 'corridors-fill', e.target.checked);
    toggleLayer(map, 'corridors-outline', e.target.checked);
  });
  document.querySelector('#toggle-gates').addEventListener('change', (e) => {
    toggleLayer(map, 'gates', e.target.checked);
  });
}

async function loadHeadline() {
  try {
    renderHeadline(await fetchHeadline());
  } catch (err) {
    console.error('[headline] load failed', err);
  }
}

async function loadChart() {
  try {
    const rows = await fetchDaily(30);
    renderChart(document.querySelector('#chart'), document.querySelector('#chart-table'), rows);
  } catch (err) {
    console.error('[chart] load failed', err);
  }
}

async function loadIncidents(map) {
  try {
    const incidents = await fetchIncidents();
    renderIncidents(document.querySelector('#incidents-list'), incidents);
    setIncidents(map, incidents);
  } catch (err) {
    console.error('[incidents] load failed', err);
  }
}

async function loadLive(map) {
  try {
    setVessels(map, await fetchLive());
  } catch (err) {
    console.error('[live] load failed', err);
  }
}

initBanner();
initTableToggle();
loadHeadline();
loadChart();
setInterval(loadHeadline, HEADLINE_REFRESH_MS);

const map = initMap(document.querySelector('#map'));
map.on('load', () => {
  initMapToggles(map);
  loadLive(map);
  loadIncidents(map);
  setInterval(() => loadLive(map), LIVE_REFRESH_MS);
});
