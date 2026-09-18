const form = document.querySelector('#booking-form');
const service = form.elements.service, date = form.elements.date, time = form.elements.time;
const message = document.querySelector('#booking-message'), submit = form.querySelector('button[type=submit]');
let sequence = 0, enabled = false, sending = false, requestId = crypto.randomUUID(), completed = false;
const say = text => { message.textContent = text; };
const resetTimes = text => { time.replaceChildren(new Option(text, '')); time.disabled = true; submit.disabled = true; };
async function api(path, options) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options?.headers } });
  let body;
  try { body = await response.json(); } catch { throw new Error('Nie udało się połączyć. Spróbuj ponownie lub zadzwoń: 697 946 177.'); }
  if (!response.ok) { const e = new Error(body.error || 'Nie udało się połączyć.'); e.status = response.status; throw e; }
  return body;
}
async function loadTimes() {
  const current = ++sequence;
  resetTimes('Wybierz usługę i dzień');
  if (!enabled || !service.value || !date.value) return;
  resetTimes('Sprawdzam wolne godziny…');
  say('');
  try {
    const data = await api(`/api/availability?service=${encodeURIComponent(service.value)}&date=${encodeURIComponent(date.value)}`);
    if (current !== sequence) return;
    resetTimes(data.slots.length ? 'Wybierz godzinę' : 'Brak wolnych godzin');
    for (const slot of data.slots) time.add(new Option(slot, slot));
    time.disabled = !data.slots.length;
    if (!data.slots.length) say('Brak dostępnych godzin. Wybierz inny dzień lub masaż.');
  } catch (e) { if (current === sequence) { resetTimes('Nie udało się pobrać godzin'); say(e.message); } }
}
service.addEventListener('change', loadTimes);
date.addEventListener('change', loadTimes);
time.addEventListener('change', () => { submit.disabled = !time.value || sending; });
form.addEventListener('input', () => {
  if (!sending) requestId = crypto.randomUUID();
  if (completed) { completed = false; say(''); }
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (sending || !enabled || !form.reportValidity()) return;
  const data = Object.fromEntries(new FormData(form));
  data.consent = form.elements.consent.checked;
  data.requestId = requestId;
  sending = true;
  const controls = [...form.elements];
  const states = controls.map(control => control.disabled);
  controls.forEach(control => { control.disabled = true; });
  say('Zapisuję zgłoszenie…');
  let result, failure;
  try { result = await api('/api/bookings', { method: 'POST', body: JSON.stringify(data) }); }
  catch (e) { failure = e; }
  sending = false;
  controls.forEach((control, index) => { control.disabled = states[index]; });
  if (result) {
    form.reset(); resetTimes('Wybierz usługę i dzień'); completed = true; requestId = crypto.randomUUID();
    say(result.message); message.focus();
  } else if (failure.status === 409) {
    await loadTimes(); say(failure.message);
  } else {
    submit.disabled = !time.value;
    say(`${failure.message} Przy ponowieniu bez zmiany danych nie utworzymy drugiego zgłoszenia.`);
  }
});
async function init() {
  try {
    const data = await api('/api/services');
    service.replaceChildren(new Option('Wybierz masaż', ''));
    data.services.forEach(s => service.add(new Option(`${s.name} · ${s.minutes} min · ${s.price}`, s.id)));
    date.min = data.today;
    const max = new Date(`${data.today}T12:00:00Z`); max.setUTCDate(max.getUTCDate() + data.schedule.horizon);
    date.max = max.toISOString().slice(0, 10);
    enabled = data.enabled; service.disabled = date.disabled = !enabled;
    say(enabled ? 'Wybierz masaż i dzień, aby zobaczyć wolne godziny.' : 'Zapisy online są chwilowo niedostępne. Zarezerwuj telefonicznie: 697 946 177.');
  } catch (e) { say(e.message); }
}
init();

