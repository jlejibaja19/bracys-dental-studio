/**
 * Bracy's Dental Studio · Reservas en línea
 * Google Apps Script que conecta el formulario de la web con Google Calendar
 * y avisa cada cita nueva por WhatsApp (CallMeBot) y por correo.
 *
 * Se pega en https://script.google.com con la cuenta de Google del consultorio.
 * Los valores de CONFIG se editan ahí, no en la web: así la clave no queda pública.
 */

const CONFIG = {
  // 'primary' = calendario principal de la cuenta. Para otro calendario, pega su ID.
  CALENDAR_ID: 'primary',

  // Duración de cada cita, en minutos.
  SLOT_MINUTES: 30,

  // Horario por día: 0 = domingo … 6 = sábado. null = cerrado.
  HOURS: {
    0: null,
    1: ['09:00', '20:00'],
    2: ['09:00', '20:00'],
    3: ['09:00', '20:00'],
    4: ['09:00', '20:00'],
    5: ['09:00', '20:00'],
    6: ['09:00', '13:00'],
  },

  // No se puede reservar con menos de estas horas de anticipación.
  MIN_NOTICE_HOURS: 2,
  // Ni con más de estos días de anticipación.
  MAX_DAYS_AHEAD: 30,

  // WhatsApp que recibe los avisos, con código de país y sin espacios. Ej.: '+51999999999'
  WHATSAPP_PHONE: '',
  // Clave que CallMeBot le envía a ese número al activarlo (ver https://www.callmebot.com).
  CALLMEBOT_APIKEY: '',

  // Correo que recibe una copia del aviso. Vacío = el correo de esta cuenta.
  NOTIFY_EMAIL: '',
};

const TZ = 'America/Lima';   // Perú, UTC-5 todo el año
const OFFSET = '-05:00';

/* ---------- Entradas desde la web ---------- */

function doGet(e) {
  try {
    const p = (e && e.parameter) || {};
    if (p.action === 'slots') return json({ ok: true, slots: freeSlots(String(p.date || '')) });
    return json({ ok: true, service: 'bracys-reservas' });
  } catch (err) {
    return json({ ok: false, error: 'server' });
  }
}

function doPost(e) {
  let d;
  try { d = JSON.parse(e.postData.contents); } catch (err) { return json({ ok: false, error: 'bad_request' }); }
  if (d.website) return json({ ok: true });            // campo trampa: lo llenan los robots

  const name = clean(d.name, 80), phone = clean(d.phone, 25), service = clean(d.service, 60);
  const doctor = clean(d.doctor, 60), note = clean(d.note, 300), lang = d.lang === 'en' ? 'en' : 'es';
  const date = String(d.date || ''), time = String(d.time || '');
  if (name.length < 3 || phone.replace(/\D/g, '').length < 7 || !service) return json({ ok: false, error: 'invalid' });

  const lock = LockService.getScriptLock();
  try { lock.waitLock(15000); } catch (err) { return json({ ok: false, error: 'busy' }); }
  try {
    if (freeSlots(date).indexOf(time) === -1) return json({ ok: false, error: 'taken' });

    const start = new Date(date + 'T' + time + ':00' + OFFSET);
    const end = new Date(start.getTime() + CONFIG.SLOT_MINUTES * 60000);
    const when = Utilities.formatDate(start, TZ, 'dd/MM/yyyy') + ' a las ' + Utilities.formatDate(start, TZ, 'HH:mm');
    const lines = [
      'Paciente: ' + name,
      'Teléfono: ' + phone,
      'Servicio: ' + service,
      'Doctor(a): ' + (doctor || 'Sin preferencia'),
      'Idioma: ' + (lang === 'en' ? 'inglés' : 'español'),
    ];
    if (note) lines.push('Nota: ' + note);

    calendar().createEvent('Cita: ' + name + ' · ' + service, start, end, {
      description: lines.join('\n') + '\n\nReservada desde la web.',
    });

    const msg = 'Nueva cita desde la web\n' + when + '\n' + lines.join('\n');
    notifyWhatsApp(msg);
    notifyEmail('Nueva cita: ' + name + ' · ' + when, msg);
    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: 'server' });
  } finally {
    lock.releaseLock();
  }
}

/* ---------- Horarios libres ---------- */

function freeSlots(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
  const noon = new Date(date + 'T12:00:00' + OFFSET);
  if (isNaN(noon.getTime())) return [];
  const hours = CONFIG.HOURS[noon.getUTCDay()];
  if (!hours) return [];

  const now = Date.now();
  const earliest = now + CONFIG.MIN_NOTICE_HOURS * 3600000;
  const latest = now + CONFIG.MAX_DAYS_AHEAD * 86400000;
  const open = new Date(date + 'T' + hours[0] + ':00' + OFFSET).getTime();
  const close = new Date(date + 'T' + hours[1] + ':00' + OFFSET).getTime();
  if (close < earliest || open > latest) return [];

  const busy = calendar().getEvents(new Date(open), new Date(close))
    .filter(function (ev) { return !ev.isAllDayEvent(); })
    .map(function (ev) { return [ev.getStartTime().getTime(), ev.getEndTime().getTime()]; });

  const step = CONFIG.SLOT_MINUTES * 60000, out = [];
  for (let t = open; t + step <= close; t += step) {
    if (t < earliest || t > latest) continue;
    const taken = busy.some(function (b) { return b[0] < t + step && b[1] > t; });
    if (!taken) out.push(Utilities.formatDate(new Date(t), TZ, 'HH:mm'));
  }
  return out;
}

/* ---------- Avisos ---------- */

function notifyWhatsApp(text) {
  if (!CONFIG.WHATSAPP_PHONE || !CONFIG.CALLMEBOT_APIKEY) return;
  try {
    const url = 'https://api.callmebot.com/whatsapp.php?phone=' + encodeURIComponent(CONFIG.WHATSAPP_PHONE) +
      '&text=' + encodeURIComponent(text) + '&apikey=' + encodeURIComponent(CONFIG.CALLMEBOT_APIKEY);
    UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  } catch (err) { /* la cita ya quedó en el calendario; el correo sirve de respaldo */ }
}

function notifyEmail(subject, body) {
  try {
    MailApp.sendEmail(CONFIG.NOTIFY_EMAIL || Session.getEffectiveUser().getEmail(), subject, body);
  } catch (err) {}
}

/* ---------- Utilidades ---------- */

function calendar() {
  return CONFIG.CALENDAR_ID === 'primary' ? CalendarApp.getDefaultCalendar() : CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);
}
function clean(v, max) { return String(v == null ? '' : v).replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, max); }
function json(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }

/**
 * Ejecuta esta función una vez desde el editor (botón ▶ Ejecutar) para dar los permisos
 * y comprobar que el aviso llega al WhatsApp y al correo.
 */
function probarAviso() {
  calendar().getName();
  const msg = 'Prueba de avisos de Bracy\'s Dental Studio. Si lees esto, las reservas de la web ya pueden avisarte.';
  notifyWhatsApp(msg);
  notifyEmail('Prueba de avisos · reservas web', msg);
}
