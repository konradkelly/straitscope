import { fetchLive, fetchDaily, fetchHeadline, fetchIncidents } from './api.js';
import { initMap, setVessels, setIncidents, toggleLayer, setRegion } from './map.js';
import { REGIONS } from '../../src/geo.js';
import { renderChart } from './chart.js';
import { renderIncidents } from './incidents.js';
import { renderHeadline } from './headline.js';
import './style.css';

const DISCLAIMER_KEY = 'straittracker-disclaimer-dismissed';
const REGION_KEY = 'straittracker-region';
const LIVE_REFRESH_MS = 30_000;
const HEADLINE_REFRESH_MS = 5 * 60_000;

const DEFAULT_REGION = REGIONS.hormuz ? 'hormuz' : Object.keys(REGIONS)[0];

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

function initRegionSwitcher(onChange) {
  const select = document.querySelector('#region-select');
  for (const [key, region] of Object.entries(REGIONS)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = region.name;
    select.appendChild(opt);
  }
  select.addEventListener('change', () => onChange(select.value));
  return select;
}

async function loadHeadline(region) {
  try {
    renderHeadline(await fetchHeadline(region));
  } catch (err) {
    console.error('[headline] load failed', err);
  }
}

async function loadChart(region) {
  try {
    const rows = await fetchDaily(region, 30);
    renderChart(document.querySelector('#chart'), document.querySelector('#chart-table'), rows);
  } catch (err) {
    console.error('[chart] load failed', err);
  }
}

async function loadIncidents(map, region) {
  try {
    const incidents = await fetchIncidents(region);
    renderIncidents(document.querySelector('#incidents-list'), incidents);
    setIncidents(map, incidents);
  } catch (err) {
    console.error('[incidents] load failed', err);
  }
}

async function loadLive(map, region) {
  try {
    setVessels(map, await fetchLive(region));
  } catch (err) {
    console.error('[live] load failed', err);
  }
}

initBanner();
initTableToggle();

let currentRegion = localStorage.getItem(REGION_KEY);
if (!REGIONS[currentRegion]) currentRegion = DEFAULT_REGION;

let liveTimer = null;

function loadAllForRegion(map, region) {
  document.querySelector('#region-subtitle').textContent = `Vessel traffic through the ${REGIONS[region].name}`;
  loadHeadline(region);
  loadChart(region);
  loadLive(map, region);
  loadIncidents(map, region);

  if (liveTimer) clearInterval(liveTimer);
  liveTimer = setInterval(() => loadLive(map, region), LIVE_REFRESH_MS);
}

const regionSelect = initRegionSwitcher((newRegion) => {
  currentRegion = newRegion;
  localStorage.setItem(REGION_KEY, newRegion);
  setRegion(map, newRegion);
  loadAllForRegion(map, newRegion);
});
regionSelect.value = currentRegion;

const map = initMap(document.querySelector('#map'), currentRegion);
map.on('load', () => {
  initMapToggles(map);
  loadAllForRegion(map, currentRegion);
  setInterval(() => loadHeadline(currentRegion), HEADLINE_REFRESH_MS);
});
