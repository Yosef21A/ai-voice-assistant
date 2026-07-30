// GET /api/appointments (range/status) and POST /api/appointments/:id/status.
// Reads the SAME appointments the engine books (legacy createAppointment writes
// clinicId; the async list matches tenantId ?? clinicId). Sandbox test-drive
// bookings are excluded so the wizard preview never pollutes the real calendar.
import express from 'express';
import { asyncHandler, isSandbox } from './http.js';

const STATUSES = new Set(['pending', 'confirmed', 'done', 'no_show', 'cancelled']);

const publicAppt = (a) => {
  const iso = a.datetimeISO ?? a.datetimeIso ?? null;
  return {
    id: a.id,
    ref: a.ref ?? null,
    status: a.status ?? 'pending',
    patientName: a.patientName ?? null,
    patientWaId: a.patientWaId ?? null,
    specialty: a.specialty ?? null,
    specialtyLabel: a.specialtyLabel ?? null,
    datetimeIso: iso,
    datetimeAdjusted: !!a.datetimeAdjusted,
    originCity: a.originCity ?? null,
    originCountry: a.originCountry ?? null,
    contact: a.contact ?? null,
    lang: a.lang ?? null,
    channel: a.channel ?? 'whatsapp',
    createdBy: a.createdBy ?? 'bot',
    createdAt: a.createdAt ?? null,
  };
};

export function appointmentsRouter({ store, bus }) {
  const router = express.Router();

  // D2: a facilitator tenant has NO local calendar — the whole surface is
  // gated, matching the dashboard (Appointments hidden, Leads is home).
  router.use((req, res, next) => {
    const clinic = typeof store.getClinicById === 'function' ? store.getClinicById(req.tenantId) : null;
    if (clinic?.type === 'facilitator') {
      return res.status(404).json({ error: 'appointments are not available for facilitator accounts' });
    }
    next();
  });

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const { status, from, to } = req.query;
      let rows = await store.appointments.list(req.tenantId, status ? { status: String(status) } : {});
      rows = rows.filter((a) => !isSandbox(a.patientWaId) && a.channel !== 'sandbox');
      if (from || to) {
        const fromT = from ? new Date(String(from)).getTime() : -Infinity;
        const toT = to ? new Date(String(to)).getTime() : Infinity;
        rows = rows.filter((a) => {
          const iso = a.datetimeISO ?? a.datetimeIso;
          const t = iso ? new Date(iso).getTime() : NaN;
          return !Number.isNaN(t) && t >= fromT && t <= toT;
        });
      }
      res.json({ appointments: rows.map(publicAppt) });
    })
  );

  router.post(
    '/:id/status',
    asyncHandler(async (req, res) => {
      const status = String(req.body?.status || '');
      if (!STATUSES.has(status)) {
        return res.status(400).json({ error: 'invalid status', allowed: [...STATUSES] });
      }
      const updated = await store.appointments.updateStatus(req.tenantId, req.params.id, status);
      if (!updated) return res.status(404).json({ error: 'appointment not found' });
      bus.publish('appointment.updated', {
        tenantId: req.tenantId,
        appointmentId: updated.id,
        status,
        appointment: publicAppt(updated),
      });
      res.json({ appointment: publicAppt(updated) });
    })
  );

  return router;
}

export { publicAppt };
