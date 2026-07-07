import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { REGIONS } from '../../src/geo.js';

// Falls back to a neutral grey for corridor names this palette doesn't know
// about — keeps regions with different corridor vocab (or none) from
// rendering blank.
const ROUTE_COLOR = [
  'match', ['get', 'name'],
  'northern', '#2a78d6',
  'southern', '#1baf7a',
  '#898781',
];
const SHIP_TYPE_COLOR = ['match', ['get', 'ship_type_class'], 'tanker', '#2a78d6', 'cargo', '#1baf7a', '#eda100'];

export function initMap(container, regionKey) {
  const region = REGIONS[regionKey];
  const map = new maplibregl.Map({
    container,
    style: 'https://demotiles.maplibre.org/style.json',
    center: region.mapCenter,
    zoom: region.mapZoom,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

  map.on('load', () => {
    map.addSource('corridors', { type: 'geojson', data: corridorsGeoJSON(regionKey) });
    map.addLayer({
      id: 'corridors-fill',
      type: 'fill',
      source: 'corridors',
      paint: { 'fill-color': ROUTE_COLOR, 'fill-opacity': 0.12 },
    });
    map.addLayer({
      id: 'corridors-outline',
      type: 'line',
      source: 'corridors',
      paint: { 'line-color': ROUTE_COLOR, 'line-width': 1.5 },
    });

    // Gates are added after corridors so their tripwire lines render on top
    // — the placeholder gate coordinates currently sit on the corridor
    // polygons' own west/east edges (spec §6.1/§6.3), so drawn underneath
    // they'd be fully hidden by the opaque corridor outline.
    map.addSource('gates', { type: 'geojson', data: gatesGeoJSON(regionKey) });
    map.addLayer({
      id: 'gates',
      type: 'line',
      source: 'gates',
      paint: { 'line-color': '#d03b3b', 'line-width': 2, 'line-dasharray': [2, 2] },
    });

    map.addSource('incidents', { type: 'geojson', data: emptyFC() });
    map.addLayer({
      id: 'incidents',
      type: 'circle',
      source: 'incidents',
      paint: {
        'circle-radius': 7,
        'circle-color': '#d03b3b',
        'circle-stroke-width': 2,
        'circle-stroke-color': '#fcfcfb',
      },
    });

    map.addSource('vessels', { type: 'geojson', data: emptyFC() });
    map.addLayer({
      id: 'vessels',
      type: 'circle',
      source: 'vessels',
      paint: {
        'circle-radius': 5,
        'circle-color': SHIP_TYPE_COLOR,
        'circle-stroke-width': 2,
        'circle-stroke-color': '#fcfcfb',
      },
    });

    map.on('click', 'vessels', (e) => {
      const f = e.features[0];
      const p = f.properties;
      // flag is omitted below when unresolved (still common — see
      // deriveFlag in src/geo.js) rather than shown as a misleading blank.
      const details = [p.ship_type_class ?? 'other', p.flag, `${Math.round(p.sog ?? 0)} kn`]
        .filter(Boolean)
        .map(escapeHTML)
        .join(' · ');
      new maplibregl.Popup()
        .setLngLat(f.geometry.coordinates.slice())
        .setHTML(`<strong>${escapeHTML(p.name || 'Unknown vessel')}</strong><br>${details}`)
        .addTo(map);
    });
    map.on('mouseenter', 'vessels', () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', 'vessels', () => (map.getCanvas().style.cursor = ''));

    map.on('click', 'incidents', (e) => {
      const f = e.features[0];
      const p = f.properties;
      new maplibregl.Popup()
        .setLngLat(f.geometry.coordinates.slice())
        .setHTML(`<strong>${escapeHTML(p.title)}</strong><br>${escapeHTML(p.date)}`)
        .addTo(map);
    });
  });

  return map;
}

export function setVessels(map, vessels) {
  const src = map.getSource('vessels');
  if (!src) return;
  src.setData({
    type: 'FeatureCollection',
    features: vessels.map((v) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [Number(v.lon), Number(v.lat)] },
      properties: {
        mmsi: v.mmsi,
        name: v.name,
        ship_type_class: v.ship_type_class ?? 'other',
        flag: v.flag,
        sog: v.sog,
      },
    })),
  });
}

export function setIncidents(map, incidents) {
  const src = map.getSource('incidents');
  if (!src) return;
  const withCoords = incidents.filter((i) => i.lat != null && i.lon != null);
  src.setData({
    type: 'FeatureCollection',
    features: withCoords.map((i) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [Number(i.lon), Number(i.lat)] },
      properties: { title: i.title, date: i.date, severity: i.severity },
    })),
  });
}

export function toggleLayer(map, id, visible) {
  if (!map.getLayer(id)) return;
  map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
}

/**
 * Switch the map to a different region: recenter/rezoom and swap the
 * corridors/gates sources. Vessel and incident sources are left for the
 * caller to refresh via setVessels/setIncidents once the new region's data
 * has loaded.
 */
export function setRegion(map, regionKey) {
  const region = REGIONS[regionKey];
  map.jumpTo({ center: region.mapCenter, zoom: region.mapZoom });
  map.getSource('corridors')?.setData(corridorsGeoJSON(regionKey));
  map.getSource('gates')?.setData(gatesGeoJSON(regionKey));
  map.getSource('vessels')?.setData(emptyFC());
  map.getSource('incidents')?.setData(emptyFC());
}

function gatesGeoJSON(regionKey) {
  const gates = REGIONS[regionKey].gates ?? {};
  return {
    type: 'FeatureCollection',
    features: Object.entries(gates).map(([name, coords]) => ({
      type: 'Feature',
      properties: { name },
      geometry: { type: 'LineString', coordinates: coords },
    })),
  };
}

function corridorsGeoJSON(regionKey) {
  const corridors = REGIONS[regionKey].corridors ?? {};
  return {
    type: 'FeatureCollection',
    features: Object.entries(corridors).map(([name, coords]) => ({
      type: 'Feature',
      properties: { name },
      geometry: { type: 'Polygon', coordinates: [[...coords, coords[0]]] },
    })),
  };
}

function emptyFC() {
  return { type: 'FeatureCollection', features: [] };
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
