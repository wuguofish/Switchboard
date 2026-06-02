// UTC is the DB storage format. Taipei (+08:00) is the API response format.

export function nowUtc(): string {
  return new Date().toISOString()  // "2026-04-15T04:09:16.004Z"
}

export function toTaipeiISOString(utcIso: string): string {
  const d = new Date(utcIso)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    fractionalSecondDigits: 3,
    hour12: false,
  }).formatToParts(d)
  const g = (t: string) => parts.find(p => p.type === t)?.value ?? '00'
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}:${g('second')}.${g('fractionalSecond')}+08:00`
}
