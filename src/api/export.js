// CSV exports (V7) — "patient data belongs to the clinic" made concrete.
// Owner-only, tenant-scoped, UTF-8 with BOM so Excel opens Arabic correctly.
import express from 'express';
import { asyncHandler, isSandbox } from './http.js';

const BOM = '﻿';

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csvLine = (cells) => cells.map(csvCell).join(',');

function sendCsv(res, filename, header, rows) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(BOM + [csvLine(header), ...rows.map(csvLine)].join('\r\n') + '\r\n');
}

function rangeFilter(query) {
  const fromT = query.from ? new Date(String(query.from)).getTime() : -Infinity;
  const toT = query.to ? new Date(String(query.to)).getTime() : Infinity;
  return (iso) => {
    const t = iso ? new Date(iso).getTime() : NaN;
    return !Number.isNaN(t) && t >= fromT && t <= toT;
  };
}

export function exportRouter({ store, requireRole }) {
  const router = express.Router();

  router.get(
    '/appointments.csv',
    requireRole('owner'),
    asyncHandler(async (req, res) => {
      const inRange = rangeFilter(req.query);
      const rows = (await store.appointments.list(req.tenantId, {}))
        .filter((a) => !isSandbox(a.patientWaId) && a.channel !== 'sandbox')
        .filter((a) => inRange(a.datetimeISO ?? a.datetimeIso ?? a.createdAt))
        .map((a) => [
          a.ref, a.status, a.specialty, a.specialtyLabel,
          a.datetimeISO ?? a.datetimeIso, a.patientName, a.patientWaId, a.contact,
          a.originCity, a.originCountry, a.lang, a.createdBy, a.createdAt,
        ]);
      sendCsv(res, 'appointments.csv',
        ['ref', 'status', 'specialty', 'specialty_label', 'datetime', 'patient_name',
         'patient_wa_id', 'contact', 'origin_city', 'origin_country', 'lang', 'created_by', 'created_at'],
        rows);
    })
  );

  router.get(
    '/leads.csv',
    requireRole('owner'),
    asyncHandler(async (req, res) => {
      const inRange = rangeFilter(req.query);
      const rows = (await store.leads.list(req.tenantId, {}))
        .filter((l) => !isSandbox(l.patientWaId))
        .filter((l) => inRange(l.createdAt))
        .map((l) => [
          l.status, l.procedure, l.details?.procedureLabel, l.originCountry,
          l.details?.originCity, l.details?.travelWindow, l.details?.reason,
          l.patientWaId, l.value, l.assignee, l.details?.snippet, l.createdAt, l.updatedAt,
        ]);
      sendCsv(res, 'leads.csv',
        ['status', 'procedure', 'procedure_label', 'origin_country', 'origin_city',
         'travel_window', 'reason', 'patient_wa_id', 'value', 'assignee', 'snippet',
         'created_at', 'updated_at'],
        rows);
    })
  );

  return router;
}
