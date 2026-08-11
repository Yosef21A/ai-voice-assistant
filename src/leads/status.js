// Lead pipeline statuses (P2-C) — ONE source of truth shared by the store
// adapters, the API validation, the stats module and the dashboard kanban so
// the column set never diverges. Order is the kanban left→right order.
export const LEAD_STATUSES = [
  'new',
  'contacted',
  'quoted',
  'negotiating',
  'booked',
  'arrived',
  'lost',
];

// "Open" = a human still owns the lead (it shows a waiting timer + gets deduped
// on capture). booked/arrived are won, lost is dead — all three are terminal.
export const LEAD_OPEN = new Set(['new', 'contacted', 'quoted', 'negotiating']);
export const LEAD_WON = new Set(['booked', 'arrived']);

export const isOpenLead = (s) => LEAD_OPEN.has(s);
export const isValidLeadStatus = (s) => LEAD_STATUSES.includes(s);
