// utils/rocUtils.js
'use strict';

const { Op } = require('sequelize');
const Reading  = require('../models/Reading');
const Meter    = require('../models/Meter');
const Stall    = require('../models/Stall');
const Building = require('../models/Building');

/* =========================
 * Basic utilities
 * =======================*/
const isYMD = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s));
const fromYMD = (s) => new Date(s + 'T00:00:00Z');
const ymd     = (d) => d.toISOString().slice(0, 10);
const ONE_DAY = 24 * 60 * 60 * 1000;
const addDays = (d, n) => new Date(d.getTime() + n * ONE_DAY);
const round   = (n, d = 2) => {
  const f = 10 ** d, x = Number(n);
  return Number.isFinite(x) ? Math.round(x * f) / f : 0;
};

// month span helpers (UTC-safe)
const dtUTC = (y,m0,d) => new Date(Date.UTC(y, m0, d));
function monthSpanFor(dateStr, monthsBack = 0) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const Y  = d.getUTCFullYear();
  const M0 = d.getUTCMonth() - monthsBack;
  const spanStart = dtUTC(Y, M0, 1);
  const spanEnd   = dtUTC(Y, M0 + 1, 0); // last day of target month
  return { start: ymd(spanStart), end: ymd(spanEnd), month: ymd(spanStart).slice(0,7) };
}

function ensureValidRange(startDate, endDate) {
  if (!isYMD(startDate) || !isYMD(endDate)) {
    const err = new Error('Invalid date(s). Use YYYY-MM-DD for both period-start and period-end.'); err.status = 400; throw err;
  }
  const s = fromYMD(startDate);
  const e = fromYMD(endDate);
  if (e < s) { const err = new Error('period-end must be on or after period-start'); err.status = 400; throw err; }
  return { start: ymd(s), end: ymd(e), days: Math.floor((e - s) / ONE_DAY) + 1 };
}

/** Previous window with the same length, immediately before {start,end}. */
function previousWindowSameLength(startDate, endDate) {
  const { start, end, days } = ensureValidRange(startDate, endDate);
  const s = fromYMD(start);
  const prevEnd   = addDays(s, -1);
  const prevStart = addDays(prevEnd, -(days - 1));
  return { start: ymd(prevStart), end: ymd(prevEnd) };
}

/** Return { curr:{start,end}, prev:{start,end} } for display and compute. */
function getDisplayForRange(startDate, endDate) {
  const curr = ensureValidRange(startDate, endDate);
  const prev = previousWindowSameLength(curr.start, curr.end);
  return { curr, prev };
}

/** Split a window into N consecutive sub-windows (nearly equal size, covering all days). */
function splitWindowIntoN(startDate, endDate, n) {
  const { start, end, days } = ensureValidRange(startDate, endDate);
  if (n < 1) { const err = new Error('Invalid slice count'); err.status = 400; throw err; }
  const s = fromYMD(start);
  const base = Math.floor(days / n);
  let rem    = days % n;

  const slices = [];
  let cursor = s;
  for (let i = 0; i < n; i++) {
    const len = base + (rem > 0 ? 1 : 0);
    if (rem > 0) rem--;
    const sliceStart = cursor;
    const sliceEnd   = addDays(cursor, len - 1);
    slices.push({ start: ymd(sliceStart), end: ymd(sliceEnd) });
    cursor = addDays(sliceEnd, 1);
  }
  // Guard against drift on final slice
  slices[slices.length - 1].end = end;
  return slices;
}

/* =========================
 * DB helpers
 * =======================*/
/** Latest reading inside [start,end] by lastread_date DESC */
async function getMaxReadingInPeriod(meter_id, start, end) {
  const row = await Reading.findOne({
    where: { meter_id, lastread_date: { [Op.gte]: start, [Op.lte]: end } },
    order: [['lastread_date', 'DESC']],
    attributes: ['reading_value', 'lastread_date'],
    raw: true
  });
  return row ? { value: Number(row.reading_value) || 0, date: row.lastread_date } : null;
}

const LPG_MIN_CON = 0; // Set to 1 if you want LPG minimum consumption
function computeUnits({ type, mult, building, prevIdx, currIdx }) {
  const t = String(type || '').toLowerCase();
  const raw = (Number(currIdx) - Number(prevIdx)) * (Number(mult) || 1);
  if (t === 'electric') {
    const min = Number(building.emin_con) || 0;
    return round(raw > 0 ? raw : min, 2);
  }
  if (t === 'water') {
    const min = Number(building.wmin_con) || 0;
    return round(raw > 0 ? raw : min, 2);
  }
  if (t === 'lpg') {
    return round(raw > 0 ? raw : LPG_MIN_CON, 2);
  }
  const err = new Error(`Unsupported meter type: ${t}`); err.status = 400; throw err;
}

/* =========================
 * Public compute (per-meter)
 * =======================*/
/**
 * Sheet-accurate ROC:
 * - current index  = max in [startDate..endDate] (user window)
 * - previous index = max in entire previous calendar month (relative to endDate)
 * - anchor index   = max in entire month before previous (relative to endDate)
 * Consumptions:
 *   anchor_to_previous   = (prev - anchor) * mult  (with minimums)
 *   previous_to_current  = (curr - prev)  * mult  (with minimums)
 *   delta = previous_to_current - anchor_to_previous
 *   rate_of_change = ceil(delta / anchor_to_previous * 100), if anchor_to_previous > 0
 */
async function computeROCForMeter({ meterId, startDate, endDate }) {
  // Resolve meter → stall → building (for minimums)
  const meter = await Meter.findOne({
    where: { meter_id: meterId },
    attributes: ['meter_id','meter_type','meter_mult','stall_id'],
    raw: true
  });
  if (!meter) { const err = new Error('Meter not found'); err.status = 404; throw err; }

  const stall = await Stall.findOne({
    where: { stall_id: meter.stall_id },
    attributes: ['stall_id','tenant_id','building_id'],
    raw: true
  });
  if (!stall) { const err = new Error('Stall not found for this meter'); err.status = 404; throw err; }

  const building = await Building.findOne({
    where: { building_id: stall.building_id },
    attributes: ['building_id','emin_con','wmin_con'],
    raw: true
  });
  if (!building) { const err = new Error('Building configuration not found'); err.status = 400; throw err; }

  // Windows
  const current  = ensureValidRange(startDate, endDate);
  const previous = monthSpanFor(endDate, 1);
  const anchor   = monthSpanFor(endDate, 2);

  // Max indices in each window
  const [currMax, prevMax, anchorMax] = await Promise.all([
    getMaxReadingInPeriod(meterId, current.start,  current.end),
    getMaxReadingInPeriod(meterId, previous.start, previous.end),
    getMaxReadingInPeriod(meterId, anchor.start,   anchor.end),
  ]);

  if (!currMax || !prevMax || !anchorMax) {
    const err = new Error(
      `Insufficient readings: need maxima in ` +
      `[${anchor.start}..${anchor.end}], ` +
      `[${previous.start}..${previous.end}], ` +
      `and [${current.start}..${current.end}].`
    );
    err.status = 400; throw err;
  }

  // Consumptions per spec (with minimums)
  const anchor_to_previous = computeUnits({
    type: meter.meter_type, mult: meter.meter_mult, building,
    prevIdx: anchorMax.value, currIdx: prevMax.value
  });

  const previous_to_current = computeUnits({
    type: meter.meter_type, mult: meter.meter_mult, building,
    prevIdx: prevMax.value, currIdx: currMax.value
  });

  const delta = Number(previous_to_current) - Number(anchor_to_previous);
  const rate_of_change = anchor_to_previous > 0
    ? Math.ceil((delta / anchor_to_previous) * 100)
    : null;

  return {
    meter_id: meter.meter_id,
    stall_id: stall.stall_id,
    tenant_id: stall.tenant_id || null,
    building_id: stall.building_id,
    meter_type: String(meter.meter_type || '').toLowerCase(),

    // Windows used
    period: {
      current:  { start: current.start,  end: current.end },
      previous: { start: previous.start, end: previous.end, month: previous.month },
      anchor:   { start: anchor.start,   end: anchor.end,   month: anchor.month }
    },

    // All three indices (explicit)
    indices: {
      anchor_index:   round(anchorMax.value, 2),
      previous_index: round(prevMax.value, 2),
      current_index:  round(currMax.value, 2)
    },

    // For backwards compatibility (if anything relies on these)
    prev_index: round(prevMax.value, 2),
    curr_index: round(currMax.value, 2),

    // All three consumptions (explicit)
    consumptions: {
      anchor_to_previous,   // (Prev - Anchor) * Mult  (min applied per type)
      previous_to_current,  // (Curr - Prev)   * Mult  (min applied per type)
      delta                 // previous_to_current - anchor_to_previous
    },

    // Legacy fields mirroring the current behavior
    current_consumption:  previous_to_current,
    previous_consumption: anchor_to_previous,
    rate_of_change
  };
}

/* =========================
 * Building-resolver for record checks
 * =======================*/
async function getBuildingIdForRequest(req) {
  const meterId = req.params?.meter_id || req.params?.id || req.body?.meter_id;
  if (!meterId) return null;
  const meter = await Meter.findOne({ where: { meter_id: meterId }, attributes: ['stall_id'], raw: true });
  if (!meter) return null;
  const stall = await Stall.findOne({ where: { stall_id: meter.stall_id }, attributes: ['building_id'], raw: true });
  return stall?.building_id || null;
}

/* =========================
 * Export
 * =======================*/
module.exports = {
  // Validation + window helpers
  isYMD,
  ensureValidRange,
  previousWindowSameLength,
  getDisplayForRange,
  splitWindowIntoN,
  // Core compute
  computeROCForMeter,
  // Record-building resolver
  getBuildingIdForRequest,
  // DB helper (useful for comparison endpoints)
  getMaxReadingInPeriod
};
