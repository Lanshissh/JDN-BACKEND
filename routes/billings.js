// routes/billings.js
'use strict';

const express = require('express');
const router = express.Router();

// Middlewares
const authenticateToken   = require('../middleware/authenticateToken');
const authorizeRole       = require('../middleware/authorizeRole');
const authorizeUtility    = require('../middleware/authorizeUtilityRole');
const {
  attachBuildingScope,
  enforceRecordBuilding,
} = require('../middleware/authorizeBuilding');

// Models used to resolve a record's building_id
const Meter = require('../models/Meter');
const Stall = require('../models/Stall');
const Billing = require('../models/Billing');
const Building = require('../models/Building');

// Utils
const getCurrentDateTime = require('../utils/getCurrentDateTime');
const {
  // standard
  computeBillingForMeter,
  computeBillingForTenant,
  computeBillingForBuilding,
  // with markup
  computeBillingForMeterWithMarkup,
  computeBillingForTenantWithMarkup,
  computeBillingForBuildingWithMarkup,
} = require('../utils/billingEngine');

// ROC util (used to append percent rate-of-change per meter)
const { computeROCForMeter } = require('../utils/rocUtils');

// Require auth for all billing routes
router.use(authenticateToken);

/** Resolve building_id for a given meter_id (for enforceRecordBuilding) */
async function resolveBuildingForMeter(req) {
  const meterId = req.params?.meter_id;
  if (!meterId) return null;

  const meter = await Meter.findOne({
    where: { meter_id: meterId },
    attributes: ['stall_id'],
    raw: true,
  });
  if (!meter) return null;

  const stall = await Stall.findOne({
    where: { stall_id: meter.stall_id },
    attributes: ['building_id'],
    raw: true,
  });
  return stall?.building_id || null;
}

/** Simple resolver that returns the :building_id param */
async function resolveBuildingFromParam(req) {
  return req.params?.building_id ? String(req.params.building_id) : null;
}


/* =============================================================================
 * BUILDING — list all stored building billings (grouped by id)
 *   GET /billings/buildings
 * ========================================================================== */
router.get(
  '/buildings',
  authorizeRole('admin', 'operator', 'biller'),
  attachBuildingScope(),
  async (req, res) => {
    try {
      const where = {};
      const allowedBuildings = req.restrictToBuildingIds ?? null;

      // If operator/biller is scoped to specific buildings, filter here
      if (Array.isArray(allowedBuildings) && allowedBuildings.length > 0) {
        where.building_id = allowedBuildings;
      }

      const billings = await Billing.findAll({
        where,
        order: [
          ['period_start', 'DESC'],
          ['building_id', 'ASC'],
        ],
      });

      // First build normalized items (same as before)
      const items = billings.map((row) => {
        const snapshot = row.payload_json || {}; // parsed JSON via model getter

        const building_id  = snapshot.building_id || row.building_id;
        const period_start = snapshot?.period?.start || row.period_start;
        const period_end   = snapshot?.period?.end   || row.period_end;

        const totals = snapshot.totals || {
          total_consumed_kwh: Number(row.total_consumed_kwh ?? 0),
          total_amount: Number(row.total_amount ?? 0),
        };

        const generated_at =
          snapshot.generated_at ||
          (row.generated_at
            ? row.generated_at.toISOString().slice(0, 19).replace('T', ' ')
            : null);

        return {
          building_billing_id: row.building_billing_id,
          building_id,
          building_name: row.building_name || null,
          period: { start: period_start, end: period_end },
          totals,
          penalty_rate_pct: Number(row.penalty_rate_pct ?? 0),
          generated_at,
          // full snapshot from when the billing was generated
          payload: snapshot,
        };
      });

      // Then group per building_billing_id
      const grouped = {};
      for (const item of items) {
        grouped[item.building_billing_id] = item;
      }

      // Return grouped object instead of { items: [...] }
      res.json(grouped);
    } catch (err) {
      console.error('Billing (building, list all grouped) error:', err);
      res.status(err.status || 500).json({ error: err.message });
    }
  }
);



/* =============================================================================
 * BUILDING fetch stored billing by header ID
 *   GET /billings/:building_billing_id
 * ========================================================================== */
router.get(
  '/buildings/:building_billing_id',
  authorizeRole('admin', 'operator', 'biller'),
  attachBuildingScope(),
  async (req, res) => {
    try {
      const { building_billing_id } = req.params;

      // Look up the billing header
      const header = await Billing.findOne({ where: { building_billing_id } });
      if (!header) {
        return res.status(404).json({ error: 'Building billing not found.' });
      }

      // Enforce building scope manually (since route param is no longer building_id)
      const allowedBuildings = req.restrictToBuildingIds ?? null;
      if (
        Array.isArray(allowedBuildings) &&
        allowedBuildings.length > 0 &&
        !allowedBuildings.includes(header.building_id)
      ) {
        return res.status(403).json({ error: 'Not allowed to view this building billing.' });
      }

      // payload_json already has the full snapshot we saved in the POST
      // via the Billing model getter this is already parsed JSON
      const snapshot = header.payload_json || {};

      // Fallbacks in case payload_json was null/empty
      const building_id  = snapshot.building_id || header.building_id;
      const period_start = snapshot?.period?.start || header.period_start;
      const period_end   = snapshot?.period?.end   || header.period_end;

      const totals = snapshot.totals || {
        total_consumed_kwh: Number(header.total_consumed_kwh ?? 0),
        total_amount: Number(header.total_amount ?? 0),
      };

      const tenants = snapshot.tenants || [];

      // Prefer the original generated_at in snapshot; otherwise use DB value
      const generated_at =
        snapshot.generated_at ||
        (header.generated_at
          ? header.generated_at.toISOString().slice(0, 19).replace('T', ' ')
          : null);

      // Return the same shape as before, plus a few extras
      res.json({
        building_billing_id: header.building_billing_id,
        building_id,
        building_name: header.building_name || null,
        period: { start: period_start, end: period_end },
        tenants,
        totals,
        penalty_rate_pct: Number(header.penalty_rate_pct ?? 0),
        generated_at,
      });
    } catch (err) {
      console.error('Billing (building, fetch by id) error:', err);
      res.status(err.status || 500).json({ error: err.message });
    }
  }
);



/* =============================================================================
 * BUILDING (standard) — CREATE building billing header (per building+period)
 *   POST /billings/buildings/:building_id/period-start/:startDate/period-end/:endDate
 * ========================================================================== */
router.post(
  '/buildings/:building_id/period-start/:startDate/period-end/:endDate',
  authorizeRole('admin', 'operator', 'biller'),
  attachBuildingScope(),
  enforceRecordBuilding(resolveBuildingFromParam),
  async (req, res) => {
    try {
      const { building_id, startDate, endDate } = req.params;

      const isYMD = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
      if (!isYMD(startDate) || !isYMD(endDate)) {
        return res.status(400).json({ error: 'Invalid date(s). Use YYYY-MM-DD.' });
      }

      const penaltyRatePct = Number(req.query.penalty_rate) || 0;

      // ---- building_name (for header) ----
      let buildingName = null;
      const building = await Building.findOne({
        where: { building_id },
        attributes: ['building_name'],
        raw: true,
      });
      buildingName = building?.building_name || null;

      // ---- SAME COMPUTE LOGIC AS YOUR GET ----
      const { meters } = await computeBillingForBuilding({
        buildingId: building_id,
        startDate,
        endDate,
        penaltyRatePct,
        restrictToBuildingIds: req.restrictToBuildingIds ?? null,
      });

      const rows = [];
      for (const entry of meters) {
        if (entry?.error) continue;

        const meterId    = entry?.meter?.meter_id;
        const meterSN    = entry?.meter?.meter_sn ?? null;
        const mult       = Number(entry?.meter?.meter_mult ?? 1);
        const stallNo    = entry?.stall?.stall_id ?? null;
        const stallSn    = entry?.stall?.stall_sn ?? null;
        const tenantId   = entry?.tenant?.tenant_id ?? null;
        const tenantName = entry?.tenant?.tenant_name ?? null;
        const tenantSn   = entry?.tenant?.tenant_sn ?? null;

        let rate_of_change_pct = null;
        let prev_consumed_kwh  = null;
        try {
          // same custom window for ROC
          const roc = await computeROCForMeter({ meterId, startDate, endDate });
          rate_of_change_pct = roc?.rate_of_change ?? null;
          prev_consumed_kwh  = roc?.previous_consumption ?? null;
        } catch {}

        const prevIdx   = Number(entry?.indices?.prev_index ?? 0);
        const currIdx   = Number(entry?.indices?.curr_index ?? 0);
        const consumed  = Number(entry?.totals?.consumption ?? 0);
        const base      = Number(entry?.totals?.base ?? 0);
        const vat       = Number(entry?.billing?.vat ?? 0);
        const totalAmt  = Number(entry?.totals?.total ?? 0);

        const utilityRate = consumed > 0 ? +(base / consumed).toFixed(6) : null; // equals system rate
        const vatRate     = base > 0 ? +(vat / base).toFixed(4) : null;

        rows.push({
          stall_no: stallNo,
          stall_sn: stallSn,
          tenant_id: tenantId,
          tenant_sn: tenantSn,
          tenant_name: tenantName,
          meter_no: meterSN,
          meter_id: meterId,
          mult: mult,
          reading_previous: prevIdx,
          reading_present: currIdx,
          consumed_kwh: consumed,
          utility_rate: utilityRate,
          markup_rate: 0,
          system_rate: utilityRate,
          vat_rate: vatRate,
          total_amount: totalAmt,
          prev_consumed_kwh: prev_consumed_kwh,
          rate_of_change_pct: rate_of_change_pct,
          tax_code: entry?.tenant?.vat_code ?? null,
          whtax_code: entry?.tenant?.wt_code ?? null,
          for_penalty: !!entry?.tenant?.for_penalty,
          meter_type: entry?.meter?.meter_type ?? null,
        });
      }

      // ---- group by tenant (same as GET) ----
      const tenantsMap = new Map();
      for (const r of rows) {
        const tkey = `${r.tenant_name ?? 'UNKNOWN'}::${r.tenant_id ?? 'NA'}`;
        if (!tenantsMap.has(tkey)) {
          tenantsMap.set(tkey, {
            tenant_id:   r.tenant_id ?? null,
            tenant_name: r.tenant_name ?? null,
            rows: [],
          });
        }
        tenantsMap.get(tkey).rows.push(r);
      }
      const tenants = Array.from(tenantsMap.values());

      const totals = rows.reduce(
        (acc, r) => {
          acc.total_consumed_kwh += Number(r.consumed_kwh) || 0;
          acc.total_amount       += Number(r.total_amount) || 0;
          return acc;
        },
        { total_consumed_kwh: 0, total_amount: 0 }
      );

      totals.total_consumed_kwh = +totals.total_consumed_kwh.toFixed(2);
      totals.total_amount       = +totals.total_amount.toFixed(2);

      const generated_at = getCurrentDateTime(); // for API output (string is fine)

      // This matches your Postman output shape
      const payload = {
        building_id,
        period: { start: startDate, end: endDate },
        tenants,
        totals,
        generated_at,
      };

      // ---- SAVE HEADER TO billing_list (one row per building+period) ----
      const building_billing_id = `${building_id}-${startDate}-${endDate}`;

      // uniqueness check
      const existing = await Billing.findOne({
        where: {
          building_id,
          period_start: startDate,
          period_end: endDate,
        },
      });

      if (existing) {
        return res.status(409).json({
          error: 'Billing already exists for this building and period.',
          building_billing_id: existing.building_billing_id,
        });
      }

      const now = new Date();

      const created = await Billing.create({
        building_billing_id,
        building_id,
        building_name: buildingName,
        period_start: startDate,
        period_end: endDate,
        total_consumed_kwh: totals.total_consumed_kwh,
        total_amount: totals.total_amount,
        penalty_rate_pct: penaltyRatePct,
        payload_json: payload, // model setter will JSON.stringify
        generated_at: now,     // DB datetime
        last_updated: now,
        updated_by: req.user?.user_id || req.user?.username || 'system',
      });

      // ---- RESPONSE ----
      res.status(201).json({
        ...payload,
        building_billing_id,
        saved_header: created,
      });
    } catch (err) {
      console.error('Billing (building, create) error:', err);
      res.status(err.status || 500).json({ error: err.message });
    }
  }
);




/* =============================================================================
 * BUILDING (with markup) — grouped by tenant; show system_rate & markup_rate
 * ========================================================================== */
router.get(
  '/with-markup/buildings/:building_id/period-start/:startDate/period-end/:endDate',
  authorizeRole('admin', 'operator', 'biller'),
  attachBuildingScope(),
  enforceRecordBuilding(resolveBuildingFromParam),
  async (req, res) => {
    try {
      const { building_id, startDate, endDate } = req.params;
      const isYMD = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
      if (!isYMD(startDate) || !isYMD(endDate)) {
        return res.status(400).json({ error: 'Invalid date(s). Use YYYY-MM-DD.' });
      }

      const penaltyRatePct = Number(req.query.penalty_rate) || 0;

      const { meters } = await computeBillingForBuildingWithMarkup({
        buildingId: building_id,
        startDate,
        endDate,
        penaltyRatePct,
        restrictToBuildingIds: req.restrictToBuildingIds ?? null,
      });

      const rows = [];
      for (const entry of meters) {
        if (entry?.error) continue;

        const meterId    = entry?.meter?.meter_id;
        const meterSN    = entry?.meter?.meter_sn ?? null;
        const mult       = Number(entry?.meter?.meter_mult ?? 1);
        const stallNo    = entry?.stall?.stall_id ?? null;
        const stallSN    = entry?.stall?.stall_sn ?? null;           // <- NEW
        const tenantId   = entry?.tenant?.tenant_id ?? null;
        const tenantSN   = entry?.tenant?.tenant_sn ?? null;         // <- NEW
        const tenantName = entry?.tenant?.tenant_name ?? null;

        let rate_of_change_pct = null;
        let prev_consumed_kwh  = null;
        try {
          // mirror the same window for ROC
          const roc = await computeROCForMeter({ meterId, startDate, endDate });
          rate_of_change_pct = roc?.rate_of_change ?? null;
          prev_consumed_kwh  = roc?.previous_consumption ?? null;
        } catch {}

        const prevIdx   = Number(entry?.indices?.prev_index ?? 0);
        const currIdx   = Number(entry?.indices?.curr_index ?? 0);
        const consumed  = Number(entry?.totals?.consumption ?? 0);
        const base      = Number(entry?.totals?.base ?? 0);
        const vat       = Number(entry?.billing?.vat ?? 0);
        const totalAmt  = Number(entry?.totals?.total ?? 0);

        const utilityRate = entry?.billing?.rates?.utility_rate ?? null;
        const markupRate  = entry?.billing?.rates?.markup_rate ?? null;
        const systemRate  = entry?.billing?.rates?.system_rate ?? (consumed > 0 ? +(base / consumed).toFixed(6) : null);
        const vatRate     = base > 0 ? +(vat / base).toFixed(4) : null;

        rows.push({
          stall_no: stallNo,
          stall_sn: stallSN,               // <- NEW
          tenant_id: tenantId,
          tenant_sn: tenantSN,             // <- NEW
          tenant_name: tenantName,
          meter_no: meterSN,
          meter_id: meterId,
          mult: mult,
          reading_previous: prevIdx,
          reading_present: currIdx,
          consumed_kwh: consumed,
          utility_rate: utilityRate,
          markup_rate: markupRate,
          system_rate: systemRate,
          vat_rate: vatRate,
          total_amount: totalAmt,
          prev_consumed_kwh: prev_consumed_kwh,
          rate_of_change_pct: rate_of_change_pct,
          tax_code: entry?.tenant?.vat_code ?? null,
          whtax_code: entry?.tenant?.wt_code ?? null,
          for_penalty: !!entry?.tenant?.for_penalty,
          meter_type: entry?.meter?.meter_type ?? null,
        });
      }

      // group by tenant (include tenant_sn)
      const tenantsMap = new Map();
      for (const r of rows) {
        const tkey = `${r.tenant_name ?? 'UNKNOWN'}::${r.tenant_id ?? 'NA'}`;
        if (!tenantsMap.has(tkey)) {
          tenantsMap.set(tkey, {
            tenant_id: r.tenant_id ?? null,
            tenant_sn: r.tenant_sn ?? null,   // <- NEW
            tenant_name: r.tenant_name ?? null,
            rows: []
          });
        }
        tenantsMap.get(tkey).rows.push(r);
      }
      const tenants = Array.from(tenantsMap.values());

      const totals = rows.reduce((acc, r) => {
        acc.total_consumed_kwh += Number(r.consumed_kwh) || 0;
        acc.total_amount       += Number(r.total_amount) || 0;
        return acc;
      }, { total_consumed_kwh: 0, total_amount: 0 });

      totals.total_consumed_kwh = +totals.total_consumed_kwh.toFixed(2);
      totals.total_amount       = +totals.total_amount.toFixed(2);

      res.json({
        building_id,
        period: { start: startDate, end: endDate },
        tenants,
        totals,
        generated_at: getCurrentDateTime(),
      });
    } catch (err) {
      console.error('Billing (building + markup) error:', err);
      res.status(err.status || 500).json({ error: err.message });
    }
  }
);

/* =============================================================================
 * BUILDING (with markup) — CREATE building billing header (per building+period)
 *   POST /billings/with-markup/buildings/:building_id/period-start/:startDate/period-end/:endDate
 * ========================================================================== */
router.post(
  '/with-markup/buildings/:building_id/period-start/:startDate/period-end/:endDate',
  authorizeRole('admin', 'operator', 'biller'),
  attachBuildingScope(),
  enforceRecordBuilding(resolveBuildingFromParam),
  async (req, res) => {
    try {
      const { building_id, startDate, endDate } = req.params;
      const isYMD = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
      if (!isYMD(startDate) || !isYMD(endDate)) {
        return res.status(400).json({ error: 'Invalid date(s). Use YYYY-MM-DD.' });
      }

      const penaltyRatePct = Number(req.query.penalty_rate) || 0;

      // ---- building_name (for header) ----
      let buildingName = null;
      const building = await Building.findOne({
        where: { building_id },
        attributes: ['building_name'],
        raw: true,
      });
      buildingName = building?.building_name || null;

      // ---- SAME COMPUTE LOGIC AS YOUR GET (but with markup) ----
      const { meters } = await computeBillingForBuildingWithMarkup({
        buildingId: building_id,
        startDate,
        endDate,
        penaltyRatePct,
        restrictToBuildingIds: req.restrictToBuildingIds ?? null,
      });

      const rows = [];
      for (const entry of meters) {
        if (entry?.error) continue;

        const meterId    = entry?.meter?.meter_id;
        const meterSN    = entry?.meter?.meter_sn ?? null;
        const mult       = Number(entry?.meter?.meter_mult ?? 1);
        const stallNo    = entry?.stall?.stall_id ?? null;
        const stallSN    = entry?.stall?.stall_sn ?? null;
        const tenantId   = entry?.tenant?.tenant_id ?? null;
        const tenantSN   = entry?.tenant?.tenant_sn ?? null;
        const tenantName = entry?.tenant?.tenant_name ?? null;

        let rate_of_change_pct = null;
        let prev_consumed_kwh  = null;
        try {
          // mirror the same window for ROC
          const roc = await computeROCForMeter({ meterId, startDate, endDate });
          rate_of_change_pct = roc?.rate_of_change ?? null;
          prev_consumed_kwh  = roc?.previous_consumption ?? null;
        } catch {}

        const prevIdx   = Number(entry?.indices?.prev_index ?? 0);
        const currIdx   = Number(entry?.indices?.curr_index ?? 0);
        const consumed  = Number(entry?.totals?.consumption ?? 0);
        const base      = Number(entry?.totals?.base ?? 0);
        const vat       = Number(entry?.billing?.vat ?? 0);
        const totalAmt  = Number(entry?.totals?.total ?? 0);

        const utilityRate = entry?.billing?.rates?.utility_rate ?? null;
        const markupRate  = entry?.billing?.rates?.markup_rate ?? null;
        const systemRate  = entry?.billing?.rates?.system_rate
          ?? (consumed > 0 ? +(base / consumed).toFixed(6) : null);
        const vatRate     = base > 0 ? +(vat / base).toFixed(4) : null;

        rows.push({
          stall_no: stallNo,
          stall_sn: stallSN,
          tenant_id: tenantId,
          tenant_sn: tenantSN,
          tenant_name: tenantName,
          meter_no: meterSN,
          meter_id: meterId,
          mult: mult,
          reading_previous: prevIdx,
          reading_present: currIdx,
          consumed_kwh: consumed,
          utility_rate: utilityRate,
          markup_rate: markupRate,
          system_rate: systemRate,
          vat_rate: vatRate,
          total_amount: totalAmt,
          prev_consumed_kwh: prev_consumed_kwh,
          rate_of_change_pct: rate_of_change_pct,
          tax_code: entry?.tenant?.vat_code ?? null,
          whtax_code: entry?.tenant?.wt_code ?? null,
          for_penalty: !!entry?.tenant?.for_penalty,
          meter_type: entry?.meter?.meter_type ?? null,
        });
      }

      // ---- group by tenant (same as GET, with tenant_sn) ----
      const tenantsMap = new Map();
      for (const r of rows) {
        const tkey = `${r.tenant_name ?? 'UNKNOWN'}::${r.tenant_id ?? 'NA'}`;
        if (!tenantsMap.has(tkey)) {
          tenantsMap.set(tkey, {
            tenant_id:   r.tenant_id ?? null,
            tenant_sn:   r.tenant_sn ?? null,
            tenant_name: r.tenant_name ?? null,
            rows: [],
          });
        }
        tenantsMap.get(tkey).rows.push(r);
      }
      const tenants = Array.from(tenantsMap.values());

      const totals = rows.reduce(
        (acc, r) => {
          acc.total_consumed_kwh += Number(r.consumed_kwh) || 0;
          acc.total_amount       += Number(r.total_amount) || 0;
          return acc;
        },
        { total_consumed_kwh: 0, total_amount: 0 }
      );

      totals.total_consumed_kwh = +totals.total_consumed_kwh.toFixed(2);
      totals.total_amount       = +totals.total_amount.toFixed(2);

      const generated_at = getCurrentDateTime();

      // This matches the shape of your with-markup building response
      const payload = {
        building_id,
        period: { start: startDate, end: endDate },
        tenants,
        totals,
        generated_at,
      };

      // ---- SAVE HEADER TO billing_list (one row per building+period) ----
      const building_billing_id = `${building_id}-${startDate}-${endDate}`;

      // uniqueness check: only one header per building+period in billing_list
      const existing = await Billing.findOne({
        where: {
          building_id,
          period_start: startDate,
          period_end: endDate,
        },
      });

      if (existing) {
        return res.status(409).json({
          error: 'Billing already exists for this building and period.',
          building_billing_id: existing.building_billing_id,
        });
      }

      const now = new Date();

      const created = await Billing.create({
        building_billing_id,
        building_id,
        building_name: buildingName,
        period_start: startDate,
        period_end: endDate,
        total_consumed_kwh: totals.total_consumed_kwh,
        total_amount: totals.total_amount,
        penalty_rate_pct: penaltyRatePct,
        payload_json: payload, // model setter will JSON.stringify
        generated_at: now,
        last_updated: now,
        updated_by: req.user?.user_id || req.user?.username || 'system',
      });

      // ---- RESPONSE ----
      res.status(201).json({
        ...payload,
        building_billing_id,
        saved_header: created,
      });
    } catch (err) {
      console.error('Billing (building + markup, create) error:', err);
      res.status(err.status || 500).json({ error: err.message });
    }
  }
);


/* =============================================================================
 * BUILDING (standard) — delete stored billing by header ID
 *   DELETE /billings/buildings/:building_billing_id
 * ========================================================================== */
router.delete(
  '/:building_billing_id',
  authorizeRole('admin', 'operator', 'biller'),
  attachBuildingScope(),
  async (req, res) => {
    try {
      const { building_billing_id } = req.params;

      // 1) Find the header
      const header = await Billing.findOne({ where: { building_billing_id } });
      if (!header) {
        return res.status(404).json({ error: 'Building billing not found.' });
      }

      // 2) Enforce building scope (same idea as GET-by-id)
      const allowedBuildings = req.restrictToBuildingIds ?? null;
      if (
        Array.isArray(allowedBuildings) &&
        allowedBuildings.length > 0 &&
        !allowedBuildings.includes(header.building_id)
      ) {
        return res.status(403).json({ error: 'Not allowed to delete this building billing.' });
      }

      // 3) Delete
      await header.destroy();

      // 4) Response
      return res.status(200).json({
        message: 'Building billing deleted successfully.',
        building_billing_id,
      });
    } catch (err) {
      console.error('Billing (building, delete by id) error:', err);
      res.status(err.status || 500).json({ error: err.message });
    }
  }
);




/* =============================================================================
 * METER (standard) — requires period-start + period-end
 * ========================================================================== */
router.get(
  '/meters/:meter_id/period-start/:startDate/period-end/:endDate',
  authorizeRole('admin', 'operator', 'biller'),
  authorizeUtility({ roles: ['operator', 'biller'], anyOf: ['electric', 'water', 'lpg'] }),
  attachBuildingScope(),
  enforceRecordBuilding(resolveBuildingForMeter),
  async (req, res) => {
    try {
      const { meter_id, startDate, endDate } = req.params;

      const isYMD = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
      if (!isYMD(startDate) || !isYMD(endDate)) {
        return res.status(400).json({ error: 'Invalid date(s). Use YYYY-MM-DD.' });
      }

      const penaltyRatePct = Number(req.query.penalty_rate) || 0;

      const result = await computeBillingForMeter({
        meterId: meter_id,
        startDate,
        endDate,
        penaltyRatePct,
        restrictToBuildingIds: req.restrictToBuildingIds ?? null,
      });

      // keep ROC in sync with same custom window
      const roc = await computeROCForMeter({ meterId: meter_id, startDate, endDate });
      const rate_of_change_percent = roc?.rate_of_change ?? null;

      const penalty_rate = (Number(penaltyRatePct) >= 1)
        ? Number(penaltyRatePct) / 100
        : Number(penaltyRatePct) || 0;

      const base = Number(result?.billing?.base ?? 0);
      const vat  = Number(result?.billing?.vat ?? 0);
      const wt   = Number(result?.billing?.wt ?? 0);
      const vat_rate = base > 0 ? +(vat / base).toFixed(4) : null;
      const wt_rate  = vat  > 0 ? +(wt  / vat ).toFixed(4) : null;

      const rates_used = {
        utility_rate: result?.billing?.rates?.utility_rate ?? null,
        markup_rate:  result?.billing?.rates?.markup_rate ?? null,
        system_rate:  result?.billing?.rates?.system_rate ?? null,
        penalty_rate
      };

      const taxes_used = {
        vat_code: result?.tenant?.vat_code || null,
        wt_code:  result?.tenant?.wt_code  || null,
        vat_rate,
        wt_rate
      };

      const consumption_breakdown = {
        previous_month_units: roc?.previous_consumption ?? null,
        current_month_units:  roc?.current_consumption ?? (result?.billing?.consumption ?? null),
        rate_of_change_percent
      };

      res.json({
        ...result,
        rate_of_change_percent,
        rates_used,
        taxes_used,
        consumption_breakdown,
        period: { start: startDate, end: endDate },
        generated_at: getCurrentDateTime()
      });
    } catch (err) {
      console.error('Billing (meter) error:', err);
      res.status(err.status || 500).json({ error: err.message });
    }
  }
);


/* =============================================================================
 * METER (standard) — CREATE billing row (compute + save)
 *   POST /billings/meters/:meter_id/period-start/:startDate/period-end/:endDate
 * ========================================================================== */
router.post(
  '/meters/:meter_id/period-start/:startDate/period-end/:endDate',
  authorizeRole('admin', 'operator', 'biller'),
  authorizeUtility({ roles: ['operator', 'biller'], anyOf: ['electric', 'water', 'lpg'] }),
  attachBuildingScope(),
  enforceRecordBuilding(resolveBuildingForMeter),
  async (req, res) => {
    try {
      const { meter_id, startDate, endDate } = req.params;

      const isYMD = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
      if (!isYMD(startDate) || !isYMD(endDate)) {
        return res.status(400).json({ error: 'Invalid date(s). Use YYYY-MM-DD.' });
      }

      const penaltyRatePct = Number(req.query.penalty_rate) || 0;

      const result = await computeBillingForMeter({
        meterId: meter_id,
        startDate,
        endDate,
        penaltyRatePct,
        restrictToBuildingIds: req.restrictToBuildingIds ?? null,
      });

      // keep ROC in sync with same custom window
      const roc = await computeROCForMeter({ meterId: meter_id, startDate, endDate });
      const rate_of_change_percent = roc?.rate_of_change ?? null;

      const penalty_rate = (Number(penaltyRatePct) >= 1)
        ? Number(penaltyRatePct) / 100
        : Number(penaltyRatePct) || 0;

      const base = Number(result?.billing?.base ?? 0);
      const vat  = Number(result?.billing?.vat ?? 0);
      const wt   = Number(result?.billing?.wt ?? 0);
      const vat_rate = base > 0 ? +(vat / base).toFixed(4) : null;
      const wt_rate  = vat  > 0 ? +(wt  / vat ).toFixed(4) : null;

      const rates_used = {
        utility_rate: result?.billing?.rates?.utility_rate ?? null,
        markup_rate:  result?.billing?.rates?.markup_rate ?? null,
        system_rate:  result?.billing?.rates?.system_rate ?? null,
        penalty_rate
      };

      const taxes_used = {
        vat_code: result?.tenant?.vat_code || null,
        wt_code:  result?.tenant?.wt_code  || null,
        vat_rate,
        wt_rate
      };

      const consumption_breakdown = {
        previous_month_units: roc?.previous_consumption ?? null,
        current_month_units:  roc?.current_consumption ?? (result?.billing?.consumption ?? null),
        rate_of_change_percent
      };

      // ---------- BUILDING NAME LOOKUP ----------
      const buildingId = result?.stall?.building_id ?? null;
      let buildingName = null;

      if (buildingId) {
        const bldg = await Building.findOne({
          where: { building_id: buildingId },
          attributes: ['building_name'],
          raw: true,
        });
        buildingName = bldg?.building_name || null;
      }

      // stall object with building_name included for the response
      const stallWithBuildingName = {
        ...result.stall,
        building_id: buildingId,
        building_name: buildingName,
      };

      // ---------- PREPARE & CHECK BILLING ID (UNIQUE) ----------
      const now = new Date();

      // simple deterministic ID; adjust if you later use a sequence
      const billing_id = `${meter_id}-${startDate}-${endDate}`;

      // make sure billing_id is unique BEFORE creating
      const existing = await Billing.findOne({ where: { billing_id } });
      if (existing) {
        return res.status(409).json({
          error: 'Billing already exists for this meter and period.',
          billing_id,
        });
      }

      // ---------- SAVE TO billing_list ----------
      const createdBilling = await Billing.create({
        billing_id,

        // scope references
        meter_id:   result?.meter?.meter_id,
        meter_sn:   result?.meter?.meter_sn ?? null,
        stall_id:   result?.stall?.stall_id ?? null,
        stall_sn:   result?.stall?.stall_sn ?? null,
        tenant_id:  result?.tenant?.tenant_id ?? null,
        tenant_sn:  result?.tenant?.tenant_sn ?? null,
        tenant_name:result?.tenant?.tenant_name ?? null,
        building_id:   buildingId,
        building_name: buildingName,

        // period
        period_start: startDate,
        period_end:   endDate,

        // meter info
        meter_type: result?.meter?.meter_type,
        meter_mult: result?.meter?.meter_mult ?? 1,

        // indices + consumption
        prev_index:    result?.indices?.prev_index ?? 0,
        curr_index:    result?.indices?.curr_index ?? 0,
        consumption:   result?.billing?.consumption ?? 0,

        // money
        base:     base,
        vat:      vat,
        wt:       wt,
        penalty:  result?.billing?.penalty ?? 0,
        total:    result?.billing?.total ?? 0,

        // rates
        utility_rate: rates_used.utility_rate,
        markup_rate:  rates_used.markup_rate,
        system_rate:  rates_used.system_rate,
        vat_rate,
        wt_rate,

        // tax codes + penalty rate used
        vat_code: taxes_used.vat_code,
        wt_code:  taxes_used.wt_code,
        penalty_rate_pct: penaltyRatePct,

        // ROC info
        rate_of_change_percent,

        // audit
        generated_at: now,
        last_updated: now,
        updated_by: req.user?.user_id || req.user?.username || 'system',
      });

      // ---------- RESPONSE ----------
      res.status(201).json({
        ...result,
        stall: stallWithBuildingName,  // now has building_name
        rate_of_change_percent,
        rates_used,
        taxes_used,
        consumption_breakdown,
        period: { start: startDate, end: endDate },
        generated_at: getCurrentDateTime(),
        billing_row: createdBilling,
      });
    } catch (err) {
      console.error('Billing (meter, create) error:', err);
      res.status(err.status || 500).json({ error: err.message });
    }
  }
);





/* =============================================================================
 * METER (with markup) — CREATE billing row (compute + save)
 *   POST /billings/with-markup/meters/:meter_id/period-start/:startDate/period-end/:endDate
 * ========================================================================== */
router.post(
  '/with-markup/meters/:meter_id/period-start/:startDate/period-end/:endDate',
  authorizeRole('admin', 'operator', 'biller'),
  authorizeUtility({ roles: ['operator', 'biller'], anyOf: ['electric', 'water', 'lpg'] }),
  attachBuildingScope(),
  enforceRecordBuilding(resolveBuildingForMeter),
  async (req, res) => {
    try {
      const { meter_id, startDate, endDate } = req.params;

      const isYMD = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s));
      if (!isYMD(startDate) || !isYMD(endDate)) {
        return res.status(400).json({ error: 'Invalid date(s). Use YYYY-MM-DD.' });
      }

      const penaltyRatePct = Number(req.query.penalty_rate) || 0;

      const result = await computeBillingForMeterWithMarkup({
        meterId: meter_id,
        startDate,
        endDate,
        penaltyRatePct,
        restrictToBuildingIds: req.restrictToBuildingIds ?? null,
      });

      // ---- Derive convenience fields (same style as GET) ----
      const penalty_rate = (Number(penaltyRatePct) >= 1)
        ? Number(penaltyRatePct) / 100
        : Number(penaltyRatePct) || 0;

      const base = Number(result?.billing?.base ?? 0);
      const vat  = Number(result?.billing?.vat ?? 0);
      const wt   = Number(result?.billing?.wt ?? 0);

      const vat_rate = base > 0 ? +(vat / base).toFixed(4) : null;
      const wt_rate  = vat  > 0 ? +(wt  / vat ).toFixed(4)  : null;

      const rates_used = {
        utility_rate: result?.billing?.rates?.utility_rate ?? null,
        markup_rate:  result?.billing?.rates?.markup_rate  ?? null,
        system_rate:  result?.billing?.rates?.system_rate  ?? null,
        penalty_rate,
      };

      const taxes_used = {
        vat_code: result?.tenant?.vat_code || null,
        wt_code:  result?.tenant?.wt_code  || null,
        vat_rate,
        wt_rate,
      };

      const rate_of_change_percent = result?.rate_of_change_percent ?? null;

      const consumption_breakdown = {
        previous_window_units:   result?.previous_units ?? null,
        current_window_units:    result?.billing?.consumption ?? null,
        rate_of_change_percent,
      };

      // ---- BUILDING NAME LOOKUP ----
      const buildingId = result?.stall?.building_id ?? null;
      let buildingName = null;

      if (buildingId) {
        const bldg = await Building.findOne({
          where: { building_id: buildingId },
          attributes: ['building_name'],
          raw: true,
        });
        buildingName = bldg?.building_name || null;
      }

      const stallWithBuildingName = {
        ...result.stall,
        building_id: buildingId,
        building_name: buildingName,
      };

      // ---- PREPARE & CHECK BILLING ID (UNIQUE) ----
      const now = new Date();

      // Same style as standard meter POST route
      const billing_id = `${meter_id}-${startDate}-${endDate}`;

      const existing = await Billing.findOne({ where: { billing_id } });
      if (existing) {
        return res.status(409).json({
          error: 'Billing already exists for this meter and period.',
          billing_id,
        });
      }

      // ---- SAVE TO billing_list ----
      const createdBilling = await Billing.create({
        billing_id,

        // scope references
        meter_id:     result?.meter?.meter_id,
        meter_sn:     result?.meter?.meter_sn ?? null,
        stall_id:     result?.stall?.stall_id ?? null,
        stall_sn:     result?.stall?.stall_sn ?? null,
        tenant_id:    result?.tenant?.tenant_id ?? null,
        tenant_sn:    result?.tenant?.tenant_sn ?? null,
        tenant_name:  result?.tenant?.tenant_name ?? null,
        building_id:  buildingId,
        building_name: buildingName,

        // period
        period_start: startDate,
        period_end:   endDate,

        // meter info
        meter_type: result?.meter?.meter_type,
        meter_mult: result?.meter?.meter_mult ?? 1,

        // indices + consumption (default 0 if not provided)
        prev_index:  Number(result?.indices?.prev_index ?? 0),
        curr_index:  Number(result?.indices?.curr_index ?? 0),
        consumption: Number(result?.billing?.consumption ?? 0),

        // money
        base,
        vat,
        wt,
        penalty: result?.billing?.penalty ?? 0,
        total:   result?.billing?.total   ?? 0,

        // rates
        utility_rate: rates_used.utility_rate,
        markup_rate:  rates_used.markup_rate,
        system_rate:  rates_used.system_rate,
        vat_rate,
        wt_rate,

        // tax codes + penalty rate used
        vat_code: taxes_used.vat_code,
        wt_code:  taxes_used.wt_code,
        penalty_rate_pct: penaltyRatePct,   // store raw (e.g. 2 for "2%")

        // ROC info
        rate_of_change_percent,

        // audit
        generated_at: now,
        last_updated: now,
        updated_by: req.user?.user_id || req.user?.username || 'system',
      });

      // ---- RESPONSE ----
      res.status(201).json({
        ...result,
        stall: stallWithBuildingName,      // includes building_name
        rate_of_change_percent,
        rates_used,
        taxes_used,
        consumption_breakdown,
        period: { start: startDate, end: endDate },
        generated_at: getCurrentDateTime(),
        billing_row: createdBilling,       // saved DB row
      });
    } catch (err) {
      console.error('Billing (meter + markup, create) error:', err);
      res.status(err.status || 500).json({ error: err.message });
    }
  }
);



/* =============================================================================
 * TENANT (standard, no markup) — requires period-start + period-end
 * ========================================================================== */
router.get(
  '/tenants/:tenant_id/period-start/:startDate/period-end/:endDate',
  authorizeRole('admin', 'operator', 'biller'),
  attachBuildingScope(),
  async (req, res) => {
    try {
      const { tenant_id, startDate, endDate } = req.params;
      const isYMD = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
      if (!isYMD(startDate) || !isYMD(endDate)) {
        return res.status(400).json({ error: 'Invalid date(s). Use YYYY-MM-DD.' });
      }

      const penaltyRatePct = Number(req.query.penalty_rate) || 0;

      const { meters, totals_by_type, grand_totals } = await computeBillingForTenant({
        tenantId: tenant_id,
        startDate,
        endDate,
        penaltyRatePct,
        restrictToBuildingIds: req.restrictToBuildingIds ?? null,
      });

      // Attach ROC per meter using the SAME window (best-effort)
      const metersWithROC = [];
      for (const entry of meters) {
        if (entry?.error) { metersWithROC.push(entry); continue; }
        const meterId = entry?.meter?.meter_id;
        let rate_of_change_percent = null;
        try {
          const roc = await computeROCForMeter({ meterId, startDate, endDate });
          rate_of_change_percent = roc?.rate_of_change ?? null;
        } catch { rate_of_change_percent = null; }
        metersWithROC.push({ ...entry, rate_of_change_percent });
      }

      res.json({
        tenant_id,
        period: { start: startDate, end: endDate },
        meters: metersWithROC,
        totals_by_type,
        grand_totals,
        generated_at: getCurrentDateTime(),
      });
    } catch (err) {
      console.error('Billing (tenant, no markup) error:', err);
      res.status(err.status || 500).json({ error: err.message });
    }
  }
);



/* =============================================================================
 * TENANT (with markup) — requires period-start + period-end
 * ========================================================================== */
router.get(
  '/with-markup/tenants/:tenant_id/period-start/:startDate/period-end/:endDate',
  authorizeRole('admin', 'operator', 'biller'),
  attachBuildingScope(),
  async (req, res) => {
    try {
      const { tenant_id, startDate, endDate } = req.params;

      const isYMD = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
      if (!isYMD(startDate) || !isYMD(endDate)) {
        return res.status(400).json({ error: 'Invalid date(s). Use YYYY-MM-DD.' });
      }

      const penaltyRatePct = Number(req.query.penalty_rate) || 0;

      const { meters, totals_by_type, grand_totals } = await computeBillingForTenantWithMarkup({
        tenantId: tenant_id,
        startDate,
        endDate,
        penaltyRatePct,
        restrictToBuildingIds: req.restrictToBuildingIds ?? null,
      });

      // attach ROC per meter using the same window (best-effort)
      const metersWithROC = [];
      for (const entry of meters) {
        if (entry?.error) { metersWithROC.push(entry); continue; }
        const meterId = entry?.meter?.meter_id;
        let rate_of_change_percent = null;
        try {
          const roc = await computeROCForMeter({ meterId, startDate, endDate });
          rate_of_change_percent = roc?.rate_of_change ?? null;
        } catch { rate_of_change_percent = null; }
        metersWithROC.push({ ...entry, rate_of_change_percent });
      }

      res.json({
        tenant_id,
        period: { start: startDate, end: endDate },
        meters: metersWithROC,
        totals_by_type,
        grand_totals,
        generated_at: getCurrentDateTime(),
      });
    } catch (err) {
      console.error('Billing (tenant + markup) error:', err);
      res.status(err.status || 500).json({ error: err.message });
    }
  }
);

module.exports = router;