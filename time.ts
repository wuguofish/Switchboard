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

// Taipei weekday as a single zh-TW character ("日一二三四五六").
// Computed via Intl with an explicit timeZone — never derived by hand, so the
// UTC/Taipei date boundary (a UTC evening is already "tomorrow" in Taipei)
// can't produce an off-by-one weekday.
export function taipeiWeekdayZh(utcIso: string): string {
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    weekday: 'narrow',
  }).format(new Date(utcIso))
}

// Heartbeat line timestamp: Taipei ISO with the weekday inlined after the
// date, e.g. "2026-07-04(六)T14:02:11.152+08:00". Only the /monitor heartbeat
// line uses this — API responses stay on plain toTaipeiISOString.
export function toTaipeiHeartbeatString(utcIso: string): string {
  const iso = toTaipeiISOString(utcIso)
  return iso.replace('T', `(${taipeiWeekdayZh(utcIso)})T`)
}
