// Availability helpers: map a JS weekday to a clinic's working-hours window and
// check whether a given Date can host a (30-minute) appointment slot.
export const WD_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export const SLOT_MIN = 30; // appointment length in minutes

export function toMins(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + (m || 0);
}

/**
 * Return the [openMins, closeMins] window for a clinic on a given date,
 * or null if the clinic is closed that day.
 */
export function windowFor(clinic, date) {
  const hours = clinic.workingHours?.[WD_KEYS[date.getDay()]];
  if (!hours) return null;
  return [toMins(hours[0]), toMins(hours[1])];
}

/**
 * True when `date` starts a slot that fully fits inside the working window.
 */
export function isWithinWorkingHours(clinic, date) {
  const win = windowFor(clinic, date);
  if (!win) return false;
  const mins = date.getHours() * 60 + date.getMinutes();
  return mins >= win[0] && mins <= win[1] - SLOT_MIN;
}
