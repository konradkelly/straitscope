async function getJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

export const fetchLive = () => getJSON('/api/v1/live');
export const fetchDaily = (days = 30) => getJSON(`/api/v1/stats/daily?days=${days}`);
export const fetchHeadline = () => getJSON('/api/v1/stats/headline');
export const fetchIncidents = () => getJSON('/api/v1/incidents');
export const fetchTrack = (mmsi, hours = 24) => getJSON(`/api/v1/vessel/${mmsi}/track?hours=${hours}`);
