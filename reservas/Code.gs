/**
 * Bracy's Dental Studio · Reservas en línea
 * Google Apps Script que conecta el formulario de la web con Google Calendar
 * (un calendario por doctor) y avisa cada cita nueva por WhatsApp (CallMeBot) y por correo.
 *
 * Se pega en https://script.google.com con la cuenta de Google del consultorio.
 * Los valores de CONFIG se editan ahí, no en la web: así la clave no queda pública.
 */

const CONFIG = {
  // Doctores que reciben citas. El nombre debe ser idéntico al de la lista "Doctor(a)" de la web.
  // Cada uno tendrá su propio calendario, llamado "Citas · <nombre>". La función configurar() los crea.
  DOCTORS: [
    'Dra. Cristina López',
    'Dr. Diego Zambrano',
    'Dra. Samantha Iturraran',
  ],

  // Duración de cada cita, en minutos.
  SLOT_MINUTES: 30,

  // Horario del consultorio por día: 0 = domingo … 6 = sábado. null = cerrado.
  // Si un doctor no atiende un día u hora, crea en SU calendario un evento "No disponible":
  // la web no ofrecerá esas horas para ese doctor.
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
const CAL_PREFIX = 'Citas · ';

/* ---------- Entradas desde la web ---------- */

function doGet(e) {
  try {
    const p = (e && e.parameter) || {};
    if (p.action === 'slots') {
      const slots = availability(String(p.date || ''), knownDoctor(p.doctor)).map(function (s) { return s.t; });
      return json({ ok: true, slots: slots });
    }
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
  const note = clean(d.note, 300), lang = d.lang === 'en' ? 'en' : 'es';
  const wanted = knownDoctor(d.doctor);
  const date = String(d.date || ''), time = String(d.time || '');
  if (name.length < 3 || phone.replace(/\D/g, '').length < 7 || !service) return json({ ok: false, error: 'invalid' });

  const lock = LockService.getScriptLock();
  try { lock.waitLock(15000); } catch (err) { return json({ ok: false, error: 'busy' }); }
  try {
    const slot = availability(date, wanted).filter(function (s) { return s.t === time; })[0];
    if (!slot) return json({ ok: false, error: 'taken' });
    // Sin preferencia: se asigna al doctor libre con menos citas ese día.
    const doctor = wanted || slot.free.sort(function (a, b) { return slot.load[a] - slot.load[b]; })[0];

    const start = new Date(date + 'T' + time + ':00' + OFFSET);
    const end = new Date(start.getTime() + CONFIG.SLOT_MINUTES * 60000);
    const when = Utilities.formatDate(start, TZ, 'dd/MM/yyyy') + ' a las ' + Utilities.formatDate(start, TZ, 'HH:mm');
    const lines = [
      'Paciente: ' + name,
      'Teléfono: ' + phone,
      'Servicio: ' + service,
      'Doctor(a): ' + doctor + (wanted ? '' : ' (asignado, sin preferencia)'),
      'Idioma: ' + (lang === 'en' ? 'inglés' : 'español'),
    ];
    if (note) lines.push('Nota: ' + note);

    doctorCalendar(doctor).createEvent('Cita: ' + name + ' · ' + service, start, end, {
      description: lines.join('\n') + '\n\nReservada desde la web.',
    });

    const msg = 'Nueva cita desde la web\n' + when + '\n' + lines.join('\n');
    notifyWhatsApp(msg);
    notifyEmail('Nueva cita: ' + name + ' · ' + doctor + ' · ' + when, msg);
    return json({ ok: true, doctor: doctor });
  } catch (err) {
    return json({ ok: false, error: 'server' });
  } finally {
    lock.releaseLock();
  }
}

/* ---------- Horarios libres ---------- */

/**
 * Devuelve las horas reservables de un día: [{ t: 'HH:mm', free: [doctores libres], load: {doctor: n.º de eventos ese día} }].
 * Con `doctor` solo mira su calendario; sin él, una hora vale si al menos un doctor está libre.
 */
function availability(date, doctor) {
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

  const doctors = doctor ? [doctor] : CONFIG.DOCTORS;
  const busy = {}, load = {};
  doctors.forEach(function (name) {
    busy[name] = doctorCalendar(name).getEvents(new Date(open), new Date(close))
      .filter(function (ev) { return !ev.isAllDayEvent(); })
      .map(function (ev) { return [ev.getStartTime().getTime(), ev.getEndTime().getTime()]; });
    load[name] = busy[name].length;
  });

  const step = CONFIG.SLOT_MINUTES * 60000, out = [];
  for (let t = open; t + step <= close; t += step) {
    if (t < earliest || t > latest) continue;
    const free = doctors.filter(function (name) {
      return !busy[name].some(function (b) { return b[0] < t + step && b[1] > t; });
    });
    if (free.length) out.push({ t: Utilities.formatDate(new Date(t), TZ, 'HH:mm'), free: free, load: load });
  }
  return out;
}

/* ---------- Calendarios ---------- */

/** Calendario del doctor. Lo busca por nombre ("Citas · Dra. …") y, si no existe, lo crea. */
function doctorCalendar(name) {
  const props = PropertiesService.getScriptProperties();
  const key = 'cal:' + name;
  const id = props.getProperty(key);
  let cal = id ? CalendarApp.getCalendarById(id) : null;
  if (!cal) {
    cal = CalendarApp.getOwnedCalendarsByName(CAL_PREFIX + name)[0] ||
          CalendarApp.createCalendar(CAL_PREFIX + name, { timeZone: TZ });
    props.setProperty(key, cal.getId());
  }
  return cal;
}

function knownDoctor(v) {
  const s = String(v == null ? '' : v).trim();
  return CONFIG.DOCTORS.indexOf(s) === -1 ? '' : s;
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

function clean(v, max) { return String(v == null ? '' : v).replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, max); }
function json(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }

/**
 * Ejecuta esta función una vez desde el editor (botón ▶ Ejecutar): pide los permisos,
 * crea un calendario por doctor y envía un aviso de prueba al WhatsApp y al correo.
 */
function configurar() {
  const names = CONFIG.DOCTORS.map(function (name) { return doctorCalendar(name).getName(); });
  Logger.log('Calendarios listos: ' + names.join(' | '));
  const msg = 'Prueba de avisos de Bracy\'s Dental Studio. Si lees esto, las reservas de la web ya pueden avisarte.';
  notifyWhatsApp(msg);
  notifyEmail('Prueba de avisos · reservas web', msg);
  Logger.log('Aviso de prueba enviado. Revisa el WhatsApp y el correo.');
}
