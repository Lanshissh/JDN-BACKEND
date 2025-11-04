// utils/billingEngine.js
'use strict';

const { Op } = require('sequelize');

const Reading  = require('../models/Reading');
const Meter    = require('../models/Meter');
const Stall    = require('../models/Stall');
const Tenant   = require('../models/Tenant');
const VAT      = require('../models/VAT');
const WT       = require('../models/WT');
const Building = require('../models/Building');

function round(n, d = 2) {
  if (n === null || n === undefined || isNaN(n)) return null;
  const f = Math.pow(10, d);
  return Math.round((Number(n) || 0) * f) / f;
}

const normalizePct = (v) => {
  const n = Number(v) || 0;
  return n >= 1 ? n / 100 : n;
};

const LPG_MIN_CON = 1;
const DAY_MS = 24 * 60 * 60 * 1000;

function ymd(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function isYMD(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function getPeriodStrings(endDateStr) {
  if (!isYMD(endDateStr)) {
    const err = new Error('Invalid end_date format. Use YYYY-MM-DD.');
    err.status = 400;
    throw err;
  }
  const end = new Date(endDateStr + 'T00:00:00Z');
  const firstOfMonth = (y, m) => new Date(Date.UTC(y, m, 1));
  const lastOfMonth  = (y, m) => new Date(Date.UTC(y, m + 1, 1) - DAY_MS);
  const y = end.getUTCFullYear();
  const m = end.getUTCMonth();
  const currStart = firstOfMonth(y, m);
  const currEnd   = end;
  const prevYear  = m === 0 ? y - 1 : y;
  const prevMonth = m === 0 ? 11 : m - 1;
  const prevStart = firstOfMonth(prevYear, prevMonth);
  const prevEnd   = lastOfMonth(prevYear, prevMonth);
  const pprevYear  = prevMonth === 0 ? prevYear - 1 : prevYear;
  const pprevMonth = prevMonth === 0 ? 11 : prevMonth - 1;
  const prePrevStart = firstOfMonth(pprevYear, pprevMonth);
  const prePrevEnd   = lastOfMonth(pprevYear, pprevMonth);
  return {
    curr:    { start: ymd(currStart),    end: ymd(currEnd) },
    prev:    { start: ymd(prevStart),    end: ymd(prevEnd) },
    preprev: { start: ymd(prePrevStart), end: ymd(prePrevEnd) },
  };
}

function getTwoSegmentWindow(endDateStr) {
  const end = new Date(endDateStr + 'T00:00:00Z');
  const endMonthStart = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  const prevMonthEnd  = new Date(endMonthStart.getTime() - DAY_MS);
  const oneMonthEarlier = new Date(Date.UTC(
    end.getUTCFullYear(),
    end.getUTCMonth() - 1,
    end.getUTCDate()
  ));
  const overallStart = new Date(oneMonthEarlier.getTime() + DAY_MS);
  const prevSegStart = overallStart.getUTCDate() === 1 ? null : overallStart;
  const prevSegEnd   = overallStart.getUTCDate() === 1 ? null : prevMonthEnd;
  const currSegStart = endMonthStart;
  const currSegEnd   = end;
  return {
    prev: prevSegStart ? { start: ymd(prevSegStart), end: ymd(prevSegEnd) } : null,
    curr: { start: ymd(currSegStart), end: ymd(currSegEnd) },
  };
}

async function getMaxReadingInPeriod(meter_id, startStr, endStr) {
  const row = await Reading.findOne({
    where: {
      meter_id,
      lastread_date: { [Op.gte]: startStr, [Op.lte]: endStr },
    },
    order: [['lastread_date', 'DESC']],
    raw: true,
  });
  return row ? { value: Number(row.reading_value) || 0, date: row.lastread_date } : null;
}

async function getTenantTaxKnobs(tenant) {
  const [vatRow, wtRow] = await Promise.all([
    tenant?.vat_code ? VAT.findOne({ where: { vat_code: tenant.vat_code }, raw: true }) : null,
    tenant?.wt_code  ? WT.findOne({ where: { wt_code:  tenant.wt_code  }, raw: true }) : null,
  ]);
  const vat = {
    e: normalizePct(vatRow?.e_vat || 0),
    w: normalizePct(vatRow?.w_vat || 0),
    l: normalizePct(vatRow?.l_vat || 0),
  };
  const wt = {
    e: normalizePct(wtRow?.e_wt || 0),
    w: normalizePct(wtRow?.w_wt || 0),
    l: normalizePct(wtRow?.l_wt || 0),
  };
  return { vat, wt };
}

function applyTaxes({ base, vatRate, wtRate, forPenalty, penaltyRate }) {
  const b = Number(base) || 0;
  const vat = b * (Number(vatRate) || 0);
  const wt  = vat * (Number(wtRate) || 0);
  const pen = forPenalty ? b * (Number(penaltyRate) || 0) : 0;
  const total = b + vat + pen - wt;
  return { vat: round(vat), wt: round(wt), penalty: round(pen), total: round(total) };
}

function getUtilityRate(mtype, building) {
  const t = String(mtype || '').toLowerCase();
  if (t === 'electric') return Number(building.erate_perKwH) || 0;
  if (t === 'water')    return Number(building.wrate_perCbM) || 0;
  if (t === 'lpg')      return Number(building.lrate_perKg)  || 0;
  throw new Error(`Unsupported meter type: ${t}`);
}

function getMinConsumption(mtype, building) {
  const t = String(mtype || '').toLowerCase();
  if (t === 'electric') return Number(building.emin_con) || 0;
  if (t === 'water')    return Number(building.wmin_con) || 0;
  if (t === 'lpg')      return LPG_MIN_CON;
  throw new Error(`Unsupported meter type: ${t}`);
}

function computeUnitsOnly(meterType, meterMult, building, prevIdx, currIdx) {
  const t = String(meterType || '').toLowerCase();
  const mult = Number(meterMult) || 1;
  const prev = Number(prevIdx) || 0;
  const curr = Number(currIdx) || 0;
  const raw = (curr - prev) * mult;
  if (t === 'electric') {
    const min = Number(building.emin_con) || 0;
    return round(raw > 0 ? raw : min);
  }
  if (t === 'water') {
    const min = Number(building.wmin_con) || 0;
    return round(raw > 0 ? raw : min);
  }
  if (t === 'lpg') {
    return round(raw > 0 ? raw : LPG_MIN_CON);
  }
  throw new Error(`Unsupported meter type: ${t}`);
}

function computeChargesByType(
  mtype, mult, building, taxKnobs, prevIdx, currIdx, forPenalty, penaltyRate
) {
  const t = String(mtype || '').toLowerCase();
  const rate = getUtilityRate(t, building);
  const vatR = t === 'electric' ? taxKnobs.vat.e : t === 'water' ? taxKnobs.vat.w : taxKnobs.vat.l;
  const wtR  = t === 'electric' ? taxKnobs.wt.e  : t === 'water' ? taxKnobs.wt.w  : taxKnobs.wt.l;
  const consumption = computeUnitsOnly(t, mult, building, prevIdx, currIdx);
  const base = consumption * rate;
  const taxes = applyTaxes({ base, vatRate: vatR, wtRate: wtR, forPenalty, penaltyRate });
  return {
    consumption: round(consumption),
    base: round(base),
    vat: taxes.vat,
    wt: taxes.wt,
    penalty: taxes.penalty,
    total: taxes.total,
    rates: { utility_rate: rate, markup_rate: 0, system_rate: rate },
  };
}

function computeChargesByTypeWithMarkup(
  mtype, mult, building, taxKnobs, prevIdx, currIdx, forPenalty, penaltyRate
) {
  const t = String(mtype || '').toLowerCase();
  const utilityRate = getUtilityRate(t, building);
  const markup      = Number(building.markup_rate) || 0;
  const systemRate  = utilityRate + markup;
  const vatR = t === 'electric' ? taxKnobs.vat.e : t === 'water' ? taxKnobs.vat.w : taxKnobs.vat.l;
  const wtR  = t === 'electric' ? taxKnobs.wt.e  : t === 'water' ? taxKnobs.wt.w  : taxKnobs.wt.l;
  const consumption = computeUnitsOnly(t, mult, building, prevIdx, currIdx);
  const base = consumption * systemRate;
  const taxes = applyTaxes({ base, vatRate: vatR, wtRate: wtR, forPenalty, penaltyRate });
  return {
    consumption: round(consumption),
    base: round(base),
    vat: taxes.vat,
    wt: taxes.wt,
    penalty: taxes.penalty,
    total: taxes.total,
    rates: { utility_rate: utilityRate, markup_rate: markup, system_rate: systemRate },
  };
}

async function computeBillingForMeter({
  meterId, endDate, penaltyRatePct = 0, restrictToBuildingIds = null
}) {
  const meter = await Meter.findOne({
    where: { meter_id: meterId },
    attributes: ['meter_id', 'meter_sn', 'meter_type', 'meter_mult', 'stall_id'],
    raw: true
  });
  if (!meter) { const e = new Error('Meter not found'); e.status = 404; throw e; }

  const stall = await Stall.findOne({
    where: { stall_id: meter.stall_id },
    attributes: ['stall_id', 'building_id', 'tenant_id'],
    raw: true
  });
  if (!stall) { const e = new Error('Stall not found for this meter'); e.status = 404; throw e; }

  if (Array.isArray(restrictToBuildingIds) && restrictToBuildingIds.length) {
    if (!restrictToBuildingIds.includes(String(stall.building_id))) {
      const e = new Error('No access to this record’s building');
      e.status = 403;
      throw e;
    }
  }

  const building = await Building.findOne({
    where: { building_id: stall.building_id },
    attributes: [
      'building_id',
      'emin_con','wmin_con',
      'erate_perKwH','wrate_perCbM','lrate_perKg',
      'markup_rate'
    ],
    raw: true
  });
  if (!building) { const e = new Error('Building not found'); e.status = 404; throw e; }

  const tenant = await Tenant.findOne({
    where: { tenant_id: stall.tenant_id },
    attributes: ['tenant_id','tenant_name','vat_code','wt_code','for_penalty'],
    raw: true
  });
  if (!tenant) { const e = new Error('Tenant not found'); e.status = 404; throw e; }

  const taxKnobs = await getTenantTaxKnobs(tenant);
  const forPenalty = !!tenant.for_penalty;
  const penaltyRate = normalizePct(penaltyRatePct);

  const indexPeriods = getPeriodStrings(endDate);
  const [prevMax, currMax] = await Promise.all([
    getMaxReadingInPeriod(meterId, indexPeriods.prev.start, indexPeriods.prev.end),
    getMaxReadingInPeriod(meterId, indexPeriods.curr.start, indexPeriods.curr.end),
  ]);
  if (!currMax) { const e = new Error(`No readings for ${indexPeriods.curr.start}..${indexPeriods.curr.end}`); e.status = 400; throw e; }
  if (!prevMax) { const e = new Error(`No readings for ${indexPeriods.prev.start}..${indexPeriods.prev.end}`); e.status = 400; throw e; }

  const displayPeriods = getTwoSegmentWindow(endDate);

  const mtype = String(meter.meter_type || '').toLowerCase();
  const mult  = Number(meter.meter_mult) || 1;

  const bill = computeChargesByType(
    mtype, mult, building, taxKnobs, prevMax.value, currMax.value, forPenalty, penaltyRate
  );

  const prevUnits = computeUnitsOnly(mtype, mult, building, prevMax.value - (mult || 1), prevMax.value);
  const currUnits = bill.consumption;
  const rateOfChangePercent = prevUnits > 0 ? round(((currUnits - prevUnits) / prevUnits) * 100, 0) : 0;

  return {
    meter: {
      meter_id: meter.meter_id,
      meter_sn: meter.meter_sn,
      meter_type: mtype,
      meter_mult: mult,
    },
    stall: {
      stall_id: stall.stall_id,
      building_id: stall.building_id,
      tenant_id: stall.tenant_id,
    },
    tenant: {
      tenant_id: tenant.tenant_id,
      tenant_name: tenant.tenant_name,
      vat_code: tenant.vat_code || null,
      wt_code: tenant.wt_code || null,
      for_penalty: forPenalty,
    },
    period: {
      previous: displayPeriods.prev,
      current: displayPeriods.curr,
    },
    indices: {
      prev_index: round(prevMax.value, 2),
      curr_index: round(currMax.value, 2),
    },
    billing: bill,
    totals: {
      consumption: bill.consumption,
      base: bill.base,
      vat: bill.vat,
      wt: bill.wt,
      penalty: bill.penalty,
      total: bill.total,
    },
    rate_of_change_percent: rateOfChangePercent,
    generated_at: new Date().toISOString().replace('T', ' ').slice(0, 19)
  };
}

async function computeBillingForMeterWithMarkup({
  meterId, endDate, penaltyRatePct = 0, restrictToBuildingIds = null
}) {
  const meter = await Meter.findOne({
    where: { meter_id: meterId },
    attributes: ['meter_id', 'meter_sn', 'meter_type', 'meter_mult', 'stall_id'],
    raw: true
  });
  if (!meter) { const e = new Error('Meter not found'); e.status = 404; throw e; }

  const stall = await Stall.findOne({
    where: { stall_id: meter.stall_id },
    attributes: ['stall_id', 'building_id', 'tenant_id'],
    raw: true
  });
  if (!stall) { const e = new Error('Stall not found for this meter'); e.status = 404; throw e; }

  if (Array.isArray(restrictToBuildingIds) && restrictToBuildingIds.length) {
    if (!restrictToBuildingIds.includes(String(stall.building_id))) {
      const e = new Error('No access to this record’s building');
      e.status = 403;
      throw e;
    }
  }

  const building = await Building.findOne({
    where: { building_id: stall.building_id },
    attributes: [
      'building_id',
      'emin_con','wmin_con',
      'erate_perKwH','wrate_perCbM','lrate_perKg',
      'markup_rate'
    ],
    raw: true
  });
  if (!building) { const e = new Error('Building not found'); e.status = 404; throw e; }

  const tenant = await Tenant.findOne({
    where: { tenant_id: stall.tenant_id },
    attributes: ['tenant_id','tenant_name','vat_code','wt_code','for_penalty'],
    raw: true
  });
  if (!tenant) { const e = new Error('Tenant not found'); e.status = 404; throw e; }

  const taxKnobs = await getTenantTaxKnobs(tenant);
  const forPenalty = !!tenant.for_penalty;
  const penaltyRate = normalizePct(penaltyRatePct);

  const indexPeriods = getPeriodStrings(endDate);
  const [prevMax, currMax] = await Promise.all([
    getMaxReadingInPeriod(meter.meter_id, indexPeriods.prev.start, indexPeriods.prev.end),
    getMaxReadingInPeriod(meter.meter_id, indexPeriods.curr.start, indexPeriods.curr.end),
  ]);
  if (!currMax) { const e = new Error(`No readings for ${indexPeriods.curr.start}..${indexPeriods.curr.end}`); e.status = 400; throw e; }
  if (!prevMax) { const e = new Error(`No readings for ${indexPeriods.prev.start}..${indexPeriods.prev.end}`); e.status = 400; throw e; }

  const displayPeriods = getTwoSegmentWindow(endDate);

  const mtype = String(meter.meter_type || '').toLowerCase();
  const mult  = Number(meter.meter_mult) || 1;

  const bill = computeChargesByTypeWithMarkup(
    mtype, mult, building, taxKnobs, prevMax.value, currMax.value, forPenalty, penaltyRate
  );

  const prevUnits = computeUnitsOnly(mtype, mult, building, prevMax.value - (mult || 1), prevMax.value);
  const currUnits = bill.consumption;
  const rateOfChangePercent = prevUnits > 0 ? round(((currUnits - prevUnits) / prevUnits) * 100, 0) : 0;

  return {
    meter: {
      meter_id: meter.meter_id,
      meter_sn: meter.meter_sn,
      meter_type: mtype,
      meter_mult: mult,
    },
    stall: {
      stall_id: stall.stall_id,
      building_id: stall.building_id,
      tenant_id: stall.tenant_id,
    },
    tenant: {
      tenant_id: tenant.tenant_id,
      tenant_name: tenant.tenant_name,
      vat_code: tenant.vat_code || null,
      wt_code: tenant.wt_code || null,
      for_penalty: forPenalty,
    },
    period: {
      previous: displayPeriods.prev,
      current: displayPeriods.curr,
    },
    indices: {
      prev_index: round(prevMax.value, 2),
      curr_index: round(currMax.value, 2),
    },
    billing: bill,
    totals: {
      consumption: bill.consumption,
      base: bill.base,
      vat: bill.vat,
      wt: bill.wt,
      penalty: bill.penalty,
      total: bill.total,
    },
    rate_of_change_percent: rateOfChangePercent,
    generated_at: new Date().toISOString().replace('T', ' ').slice(0, 19)
  };
}

async function computeBillingForTenant({
  tenantId, endDate, penaltyRatePct = 0, restrictToBuildingIds = null
}) {
  const stalls = await Stall.findAll({
    where: { tenant_id: tenantId },
    attributes: ['stall_id','building_id','tenant_id'],
    raw: true
  });

  if (!stalls.length) {
    return { meters: [], totals_by_type: { electric:{base:0,vat:0,wt:0,penalty:0,total:0}, water:{base:0,vat:0,wt:0,penalty:0,total:0}, lpg:{base:0,vat:0,wt:0,penalty:0,total:0} }, grand_totals: { base:0,vat:0,wt:0,penalty:0,total:0 } };
  }

  const meters = await Meter.findAll({
    where: { stall_id: { [Op.in]: stalls.map(s => s.stall_id) } },
    attributes: ['meter_id','meter_sn','meter_type','meter_mult','stall_id'],
    raw: true
  });

  const results = [];
  const totals_by_type = {
    electric: { base:0, vat:0, wt:0, penalty:0, total:0 },
    water:    { base:0, vat:0, wt:0, penalty:0, total:0 },
    lpg:      { base:0, vat:0, wt:0, penalty:0, total:0 }
  };
  const grand_totals = { base:0, vat:0, wt:0, penalty:0, total:0 };

  for (const m of meters) {
    const r = await computeBillingForMeter({
      meterId: m.meter_id,
      endDate,
      penaltyRatePct,
      restrictToBuildingIds
    });
    results.push(r);
    const k = r.meter.meter_type;
    totals_by_type[k].base    += r.billing.base;
    totals_by_type[k].vat     += r.billing.vat;
    totals_by_type[k].wt      += r.billing.wt;
    totals_by_type[k].penalty += r.billing.penalty;
    totals_by_type[k].total   += r.billing.total;
    grand_totals.base    += r.billing.base;
    grand_totals.vat     += r.billing.vat;
    grand_totals.wt      += r.billing.wt;
    grand_totals.penalty += r.billing.penalty;
    grand_totals.total   += r.billing.total;
  }

  Object.keys(totals_by_type).forEach(k => {
    totals_by_type[k].base    = round(totals_by_type[k].base);
    totals_by_type[k].vat     = round(totals_by_type[k].vat);
    totals_by_type[k].wt      = round(totals_by_type[k].wt);
    totals_by_type[k].penalty = round(totals_by_type[k].penalty);
    totals_by_type[k].total   = round(totals_by_type[k].total);
  });
  grand_totals.base    = round(grand_totals.base);
  grand_totals.vat     = round(grand_totals.vat);
  grand_totals.wt      = round(grand_totals.wt);
  grand_totals.penalty = round(grand_totals.penalty);
  grand_totals.total   = round(grand_totals.total);

  return { meters: results, totals_by_type, grand_totals };
}

async function computeBillingForTenantWithMarkup({
  tenantId, endDate, penaltyRatePct = 0, restrictToBuildingIds = null
}) {
  const stalls = await Stall.findAll({
    where: { tenant_id: tenantId },
    attributes: ['stall_id','building_id','tenant_id'],
    raw: true
  });

  if (!stalls.length) {
    return { meters: [], totals_by_type: { electric:{base:0,vat:0,wt:0,penalty:0,total:0}, water:{base:0,vat:0,wt:0,penalty:0,total:0}, lpg:{base:0,vat:0,wt:0,penalty:0,total:0} }, grand_totals: { base:0,vat:0,wt:0,penalty:0,total:0 } };
  }

  const meters = await Meter.findAll({
    where: { stall_id: { [Op.in]: stalls.map(s => s.stall_id) } },
    attributes: ['meter_id','meter_sn','meter_type','meter_mult','stall_id'],
    raw: true
  });

  const results = [];
  const totals_by_type = {
    electric: { base:0, vat:0, wt:0, penalty:0, total:0 },
    water:    { base:0, vat:0, wt:0, penalty:0, total:0 },
    lpg:      { base:0, vat:0, wt:0, penalty:0, total:0 }
  };
  const grand_totals = { base:0, vat:0, wt:0, penalty:0, total:0 };

  for (const m of meters) {
    const r = await computeBillingForMeterWithMarkup({
      meterId: m.meter_id,
      endDate,
      penaltyRatePct,
      restrictToBuildingIds
    });
    results.push(r);
    const k = r.meter.meter_type;
    totals_by_type[k].base    += r.billing.base;
    totals_by_type[k].vat     += r.billing.vat;
    totals_by_type[k].wt      += r.billing.wt;
    totals_by_type[k].penalty += r.billing.penalty;
    totals_by_type[k].total   += r.billing.total;
    grand_totals.base    += r.billing.base;
    grand_totals.vat     += r.billing.vat;
    grand_totals.wt      += r.billing.wt;
    grand_totals.penalty += r.billing.penalty;
    grand_totals.total   += r.billing.total;
  }

  Object.keys(totals_by_type).forEach(k => {
    totals_by_type[k].base    = round(totals_by_type[k].base);
    totals_by_type[k].vat     = round(totals_by_type[k].vat);
    totals_by_type[k].wt      = round(totals_by_type[k].wt);
    totals_by_type[k].penalty = round(totals_by_type[k].penalty);
    totals_by_type[k].total   = round(totals_by_type[k].total);
  });
  grand_totals.base    = round(grand_totals.base);
  grand_totals.vat     = round(grand_totals.vat);
  grand_totals.wt      = round(grand_totals.wt);
  grand_totals.penalty = round(grand_totals.penalty);
  grand_totals.total   = round(grand_totals.total);

  return { meters: results, totals_by_type, grand_totals };
}


async function computeBillingForTenantWithMarkup({
  tenantId, endDate, penaltyRatePct = 0, restrictToBuildingIds = null
}) {
  const stalls = await Stall.findAll({
    where: { tenant_id: tenantId },
    attributes: ['stall_id','building_id','tenant_id'],
    raw: true
  });

  if (!stalls.length) {
    return {
      meters: [],
      totals_by_type: {
        electric: { base:0, vat:0, wt:0, penalty:0, total:0 },
        water:    { base:0, vat:0, wt:0, penalty:0, total:0 },
        lpg:      { base:0, vat:0, wt:0, penalty:0, total:0 }
      },
      grand_totals: { base:0, vat:0, wt:0, penalty:0, total:0 }
    };
  }

  const meters = await Meter.findAll({
    where: { stall_id: { [Op.in]: stalls.map(s => s.stall_id) } },
    attributes: ['meter_id','meter_sn','meter_type','meter_mult','stall_id'],
    raw: true
  });

  const results = [];
  const totals_by_type = {
    electric: { base:0, vat:0, wt:0, penalty:0, total:0 },
    water:    { base:0, vat:0, wt:0, penalty:0, total:0 },
    lpg:      { base:0, vat:0, wt:0, penalty:0, total:0 }
  };
  const grand_totals = { base:0, vat:0, wt:0, penalty:0, total:0 };

  for (const m of meters) {
    const r = await computeBillingForMeterWithMarkup({
      meterId: m.meter_id,
      endDate,
      penaltyRatePct,
      restrictToBuildingIds
    });
    results.push(r);
    const k = r.meter.meter_type;
    totals_by_type[k].base    += r.billing.base;
    totals_by_type[k].vat     += r.billing.vat;
    totals_by_type[k].wt      += r.billing.wt;
    totals_by_type[k].penalty += r.billing.penalty;
    totals_by_type[k].total   += r.billing.total;
    grand_totals.base    += r.billing.base;
    grand_totals.vat     += r.billing.vat;
    grand_totals.wt      += r.billing.wt;
    grand_totals.penalty += r.billing.penalty;
    grand_totals.total   += r.billing.total;
  }

  Object.keys(totals_by_type).forEach(k => {
    totals_by_type[k].base    = round(totals_by_type[k].base);
    totals_by_type[k].vat     = round(totals_by_type[k].vat);
    totals_by_type[k].wt      = round(totals_by_type[k].wt);
    totals_by_type[k].penalty = round(totals_by_type[k].penalty);
    totals_by_type[k].total   = round(totals_by_type[k].total);
  });
  grand_totals.base    = round(grand_totals.base);
  grand_totals.vat     = round(grand_totals.vat);
  grand_totals.wt      = round(grand_totals.wt);
  grand_totals.penalty = round(grand_totals.penalty);
  grand_totals.total   = round(grand_totals.total);

  return { meters: results, totals_by_type, grand_totals };
}


async function computeBillingForBuilding({
  buildingId, endDate, penaltyRatePct = 0, restrictToBuildingIds = null
}) {
  const bid = String(buildingId);

  if (Array.isArray(restrictToBuildingIds) && restrictToBuildingIds.length) {
    if (!restrictToBuildingIds.includes(bid)) {
      const e = new Error('No access to this building');
      e.status = 403;
      throw e;
    }
  }

  const stalls = await Stall.findAll({
    where: { building_id: bid },
    attributes: ['stall_id','building_id','tenant_id'],
    raw: true
  });

  const meters = await Meter.findAll({
    where: { stall_id: { [Op.in]: stalls.map(s => s.stall_id) } },
    attributes: ['meter_id','meter_sn','meter_type','meter_mult','stall_id'],
    raw: true
  });

  const results = [];
  const totals_by_type = {
    electric: { base:0, vat:0, wt:0, penalty:0, total:0 },
    water:    { base:0, vat:0, wt:0, penalty:0, total:0 },
    lpg:      { base:0, vat:0, wt:0, penalty:0, total:0 }
  };
  const grand_totals = { base:0, vat:0, wt:0, penalty:0, total:0 };

  for (const m of meters) {
    try {
      const r = await computeBillingForMeter({
        meterId: m.meter_id,
        endDate,
        penaltyRatePct,
        restrictToBuildingIds
      });

      results.push(r);

      const k = r.meter.meter_type;
      totals_by_type[k].base    += r.billing.base;
      totals_by_type[k].vat     += r.billing.vat;
      totals_by_type[k].wt      += r.billing.wt;
      totals_by_type[k].penalty += r.billing.penalty;
      totals_by_type[k].total   += r.billing.total;

      grand_totals.base    += r.billing.base;
      grand_totals.vat     += r.billing.vat;
      grand_totals.wt      += r.billing.wt;
      grand_totals.penalty += r.billing.penalty;
      grand_totals.total   += r.billing.total;
    } catch (e) {
      if (String(e?.message || '').toLowerCase() === 'tenant not found') {
        continue;
      }
      throw e;
    }
  }

  Object.keys(totals_by_type).forEach(k => {
    totals_by_type[k].base    = round(totals_by_type[k].base);
    totals_by_type[k].vat     = round(totals_by_type[k].vat);
    totals_by_type[k].wt      = round(totals_by_type[k].wt);
    totals_by_type[k].penalty = round(totals_by_type[k].penalty);
    totals_by_type[k].total   = round(totals_by_type[k].total);
  });

  grand_totals.base    = round(grand_totals.base);
  grand_totals.vat     = round(grand_totals.vat);
  grand_totals.wt      = round(grand_totals.wt);
  grand_totals.penalty = round(grand_totals.penalty);
  grand_totals.total   = round(grand_totals.total);

  return { meters: results, totals_by_type, grand_totals };
}


async function computeBillingForBuildingWithMarkup({
  buildingId, endDate, penaltyRatePct = 0, restrictToBuildingIds = null
}) {
  const bid = String(buildingId);

  if (Array.isArray(restrictToBuildingIds) && restrictToBuildingIds.length) {
    if (!restrictToBuildingIds.includes(bid)) {
      const e = new Error('No access to this building');
      e.status = 403;
      throw e;
    }
  }

  const stalls = await Stall.findAll({
    where: { building_id: bid },
    attributes: ['stall_id','building_id','tenant_id'],
    raw: true
  });

  const meters = await Meter.findAll({
    where: { stall_id: { [Op.in]: stalls.map(s => s.stall_id) } },
    attributes: ['meter_id','meter_sn','meter_type','meter_mult','stall_id'],
    raw: true
  });

  const results = [];
  const totals_by_type = {
    electric: { base:0, vat:0, wt:0, penalty:0, total:0 },
    water:    { base:0, vat:0, wt:0, penalty:0, total:0 },
    lpg:      { base:0, vat:0, wt:0, penalty:0, total:0 }
  };
  const grand_totals = { base:0, vat:0, wt:0, penalty:0, total:0 };

  for (const m of meters) {
    try {
      const r = await computeBillingForMeterWithMarkup({
        meterId: m.meter_id,
        endDate,
        penaltyRatePct,
        restrictToBuildingIds
      });

      results.push(r);

      const k = r.meter.meter_type;
      totals_by_type[k].base    += r.billing.base;
      totals_by_type[k].vat     += r.billing.vat;
      totals_by_type[k].wt      += r.billing.wt;
      totals_by_type[k].penalty += r.billing.penalty;
      totals_by_type[k].total   += r.billing.total;

      grand_totals.base    += r.billing.base;
      grand_totals.vat     += r.billing.vat;
      grand_totals.wt      += r.billing.wt;
      grand_totals.penalty += r.billing.penalty;
      grand_totals.total   += r.billing.total;
    } catch (e) {
      if (String(e?.message || '').toLowerCase() === 'tenant not found') {
        continue;
      }
      throw e;
    }
  }

  Object.keys(totals_by_type).forEach(k => {
    totals_by_type[k].base    = round(totals_by_type[k].base);
    totals_by_type[k].vat     = round(totals_by_type[k].vat);
    totals_by_type[k].wt      = round(totals_by_type[k].wt);
    totals_by_type[k].penalty = round(totals_by_type[k].penalty);
    totals_by_type[k].total   = round(totals_by_type[k].total);
  });

  grand_totals.base    = round(grand_totals.base);
  grand_totals.vat     = round(grand_totals.vat);
  grand_totals.wt      = round(grand_totals.wt);
  grand_totals.penalty = round(grand_totals.penalty);
  grand_totals.total   = round(grand_totals.total);

  return { meters: results, totals_by_type, grand_totals };
}


module.exports = {
  computeBillingForMeter,
  computeBillingForTenant,
  computeBillingForBuilding,
  computeBillingForMeterWithMarkup,
  computeBillingForTenantWithMarkup,
  computeBillingForBuildingWithMarkup,
  round,
  normalizePct,
  getTwoSegmentWindow,
  getMaxReadingInPeriod,
  getTenantTaxKnobs,
  computeChargesByType,
  applyTaxes,
};
