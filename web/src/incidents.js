const SEVERITY_LABEL = { info: 'Info', attack: 'Attack', grounding: 'Grounding', seizure: 'Seizure' };

export function renderIncidents(container, incidents) {
  container.replaceChildren();

  if (incidents.length === 0) {
    const li = document.createElement('li');
    li.className = 'incident-empty';
    li.textContent = 'No incidents recorded yet.';
    container.appendChild(li);
    return;
  }

  for (const inc of incidents) {
    const li = document.createElement('li');
    li.className = `incident incident-${inc.severity}`;

    const meta = document.createElement('div');
    const date = document.createElement('span');
    date.className = 'incident-date';
    date.textContent = inc.date;
    const severity = document.createElement('span');
    severity.className = 'incident-severity';
    severity.textContent = SEVERITY_LABEL[inc.severity] ?? inc.severity;
    meta.append(date, severity);

    const title = document.createElement('h3');
    title.textContent = inc.title;

    const summary = document.createElement('p');
    summary.textContent = inc.summary;

    li.append(meta, title, summary);

    if (typeof inc.source_url === 'string' && inc.source_url.startsWith('http')) {
      const link = document.createElement('a');
      link.href = inc.source_url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = 'Source';
      li.appendChild(link);
    }

    container.appendChild(li);
  }
}
