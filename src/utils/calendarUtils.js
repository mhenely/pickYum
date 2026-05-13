const pad = (n) => String(n).padStart(2, '0');

// Local floating time — no Z suffix so calendar apps use the device timezone
function toICSLocal(date) {
  return (
    date.getFullYear() +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    'T' +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    '00'
  );
}

// UTC time with Z — used for DTSTAMP and Google Calendar URL
function toICSUtc(date) {
  return (
    date.getUTCFullYear() +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    'T' +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    '00Z'
  );
}

function escapeICS(str) {
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

export function generateICS({ title, startDate, endDate, description }) {
  const uid = `${Date.now()}-${Math.random().toString(36).slice(2)}@pickyum`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//pickYum//Restaurant Scheduler//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${toICSUtc(new Date())}`,
    `DTSTART:${toICSLocal(startDate)}`,
    `DTEND:${toICSLocal(endDate)}`,
    `SUMMARY:${escapeICS(title)}`,
    description ? `DESCRIPTION:${escapeICS(description)}` : null,
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean);

  return lines.join('\r\n');
}

export function downloadICS(icsContent, filename) {
  const blob = new Blob([icsContent], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function buildGoogleCalendarUrl({ title, startDate, endDate, description }) {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: title,
    dates: `${toICSUtc(startDate)}/${toICSUtc(endDate)}`,
    details: description ?? '',
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
