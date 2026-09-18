export const schedule = {
  timezone: 'Europe/Warsaw', days: [0, 1, 2, 3, 4, 5, 6],
  open: 600, close: 1290, buffer: 60, step: 30, horizon: 60, notice: 120,
  closedDates: []
};
export const services = [
  { id: 'relaks', name: 'Masaż relaksacyjny', minutes: 60, price: 'od 100 zł' },
  { id: 'plecy', name: 'Plecy i kręgosłup', minutes: 50, price: '120 zł' },
  { id: 'leczniczy', name: 'Masaż leczniczy', minutes: 60, price: '160 zł' },
  { id: 'lomi', name: 'Lomi Lomi', minutes: 90, price: 'od 150 zł' },
  { id: 'kamienie', name: 'Gorące kamienie', minutes: 90, price: '200 zł' },
  { id: 'kark', name: 'Kark i szyja', minutes: 30, price: '90 zł' }
];
export const toMinutes = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
export const toTime = minutes => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
export function localNow(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: schedule.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(now).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute) };
}
export function validDate(date, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T12:00:00Z`);
  if (!Number.isFinite(+parsed) || parsed.toISOString().slice(0, 10) !== date) return false;
  const today = localNow(now).date;
  const days = (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000;
  return days >= 0 && days <= schedule.horizon && schedule.days.includes(parsed.getUTCDay()) && !schedule.closedDates.includes(date);
}
export function slots(date, service, bookings, now = new Date()) {
  if (!validDate(date, now)) return [];
  const current = localNow(now);
  const available = [];
  for (let start = schedule.open; start + service.minutes <= schedule.close; start += schedule.step) {
    if (date === current.date && start < current.minute + schedule.notice) continue;
    if (bookings.some(b => start < toMinutes(b.booking_time) + b.duration_minutes + b.buffer_minutes &&
      start + service.minutes + schedule.buffer > toMinutes(b.booking_time))) continue;
    available.push(toTime(start));
  }
  return available;
}

