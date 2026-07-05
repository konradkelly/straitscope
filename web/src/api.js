async function getJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

export const fetchLive = (region) => getJSON(`/api/v1/live?region=${region}`);
export const fetchDaily = (region, days = 30) => getJSON(`/api/v1/stats/daily?region=${region}&days=${days}`);
export const fetchHeadline = (region) => getJSON(`/api/v1/stats/headline?region=${region}`);
export const fetchIncidents = (region) => getJSON(`/api/v1/incidents?region=${region}`);
export const fetchTrack = (region, mmsi, hours = 24) =>
  getJSON(`/api/v1/vessel/${mmsi}/track?region=${region}&hours=${hours}`);
