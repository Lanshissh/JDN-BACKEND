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

// Utils
const getCurrentDateTime = require('../utils/getCurrentDateTime');
const {
  computeBillingForMeter,
  computeBillingForTenant,
  computeBillingForBuilding,
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

/**
 * PER BUILDING — grouped by tenant, ROC only per meter (clean output)
 * GET /billings/buildings/:building_id/period-end/:endDate
 * - endDate: YYYY-MM-DD
 * - optional query: ?penalty_rate=2
 *
 * Output:
 * {
 *   building_id,
 *   end_date,
 *   tenants: [{ tenant_id, tenant_name, rows: [ ... ] }],
 *   totals: { total_consumed_kwh, total_amount },
 *   generated_at
 * }
 */
router.get(
  '/buildings/:building_id/period-end/:endDate',
  authorizeRole('admin', 'operator', 'biller'),
  attachBuildingScope(),
  enforceRecordBuilding(resolveBuildingFromParam),
  async (req, res) => {
    try {
      const { building_id, endDate } = req.params;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
        return res.status(400).json({ error: 'Invalid endDate. Use YYYY-MM-DD.' });
      }

      const penaltyRatePct = Number(req.query.penalty_rate) || 0;

      // Compute billing for the whole building (engine stays pure)
      const { meters } = await computeBillingForBuilding({
        buildingId: building_id,
        endDate,
        penaltyRatePct,
        restrictToBuildingIds: req.restrictToBuildingIds ?? null,
      });

      // 1) Decorate each meter with ROC (%) and transform into flat row objects
      const rows = [];
      for (const entry of meters) {
        if (entry?.error) continue; // skip error rows from clean output

        const meterId    = entry?.meter?.meter_id;
        const meterSN    = entry?.meter?.meter_sn ?? null;
        const mult       = Number(entry?.meter?.meter_mult ?? 1);
        const stallNo    = entry?.stall?.stall_id ?? null;
        const tenantId   = entry?.tenant?.tenant_id ?? null;
        const tenantName = entry?.tenant?.tenant_name ?? null;

        // ROC (% + previous consumption)
        let rate_of_change_pct = null;
        let prev_consumed_kwh  = null;
        try {
          const roc = await computeROCForMeter({ meterId, endDate });
          rate_of_change_pct = roc?.rate_of_change ?? null;
          prev_consumed_kwh  = roc?.previous_consumption ?? null;
        } catch { /* leave nulls */ }

        const prevIdx   = Number(entry?.indices?.prev_index ?? 0);
        const currIdx   = Number(entry?.indices?.curr_index ?? 0);
        const consumed  = Number(entry?.totals?.consumption ?? 0);
        const base      = Number(entry?.totals?.base ?? 0);
        const vat       = Number(entry?.billing?.vat ?? 0);
        const totalAmt  = Number(entry?.totals?.total ?? 0);

        // Derived helpers for sheet columns
        const utilityRate  = consumed > 0 ? +(base / consumed).toFixed(6) : null; // Php per kWh
        const vatRate   = base > 0 ? +(vat / base).toFixed(4) : null;          // e.g., 0.12

        rows.push({
          stall_no: stallNo,
          tenant_id: tenantId,
          tenant_name: tenantName,
          meter_no: meterSN,
          meter_id: meterId,
          mult: mult,
          reading_previous: prevIdx,
          reading_present: currIdx,
          consumed_kwh: consumed,
          utility_rate: utilityRate,
          vat_rate: vatRate,
          total_amount: totalAmt,
          prev_consumed_kwh: prev_consumed_kwh,
          rate_of_change_pct: rate_of_change_pct, // integer (ceil) from your ROC util
          tax_code: entry?.tenant?.vat_code ?? null,
          whtax_code: entry?.tenant?.wt_code ?? null,
          for_penalty: !!entry?.tenant?.for_penalty,
          meter_type: entry?.meter?.meter_type ?? null,
        });
      }

      // 2) Group rows by tenant
      const tenantsMap = new Map();
      for (const r of rows) {
        const tkey = `${r.tenant_name ?? 'UNKNOWN'}::${r.tenant_id ?? 'NA'}`;
        if (!tenantsMap.has(tkey)) {
          tenantsMap.set(tkey, { tenant_id: r.tenant_id ?? null, tenant_name: r.tenant_name ?? null, rows: [] });
        }
        tenantsMap.get(tkey).rows.push(r);
      }
      const tenants = Array.from(tenantsMap.values());

      // 3) Sheet-level totals
      const totals = rows.reduce((acc, r) => {
        acc.total_consumed_kwh += Number(r.consumed_kwh) || 0;
        acc.total_amount       += Number(r.total_amount) || 0;
        return acc;
      }, { total_consumed_kwh: 0, total_amount: 0 });

      // Round totals for display
      totals.total_consumed_kwh = +totals.total_consumed_kwh.toFixed(2);
      totals.total_amount       = +totals.total_amount.toFixed(2);

      res.json({
        building_id,
        end_date: endDate,
        tenants,   // [{ tenant_id, tenant_name, rows: [ ...clean rows...] }]
        totals,    // { total_consumed_kwh, total_amount }
        generated_at: getCurrentDateTime(),
      });
    } catch (err) {
      console.error('Billing (building) clean output error:', err);
      res.status(err.status || 500).json({ error: err.message });
    }
  }
);

/**
 * PER METER
 * GET /billings/meters/:meter_id/period-end/:endDate
 * - endDate: YYYY-MM-DD
 * - optional query: ?penalty_rate=2  (percent)
 *
 * Chain:
 *  - authenticateToken (router-level)
 *  - authorizeRole('admin','operator','biller')
 *  - authorizeUtility({ roles:['operator','biller'], anyOf:['electric','water','lpg'] })
 *  - attachBuildingScope()
 *  - enforceRecordBuilding(resolveBuildingForMeter)
 */
router.get(
  '/meters/:meter_id/period-end/:endDate',
  authorizeRole('admin', 'operator', 'biller'),
  authorizeUtility({ roles: ['operator', 'biller'], anyOf: ['electric', 'water', 'lpg'] }),
  attachBuildingScope(),
  enforceRecordBuilding(resolveBuildingForMeter),
  async (req, res) => {
    try {
      const { meter_id, endDate } = req.params;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
        return res.status(400).json({ error: 'Invalid endDate. Use YYYY-MM-DD.' });
      }

      const penaltyRatePct = Number(req.query.penalty_rate) || 0;

      const result = await computeBillingForMeter({
        meterId: meter_id,
        endDate,
        penaltyRatePct,
        restrictToBuildingIds: req.restrictToBuildingIds ?? null, // null => admin (no restriction)
      });

      const roc = await computeROCForMeter({ meterId: meter_id, endDate });
      const rate_of_change_percent = roc?.rate_of_change ?? null;

      res.json({
        ...result,
        rate_of_change_percent, // integer percent (ceil) or null
        generated_at: getCurrentDateTime(),
      });
    } catch (err) {
      console.error('Billing (meter) error:', err);
      res.status(err.status || 500).json({ error: err.message });
    }
  }
);

/**
 * PER TENANT
 * GET /billings/tenants/:tenant_id/period-end/:endDate
 * - endDate: YYYY-MM-DD
 * - optional query: ?penalty_rate=2  (percent)
 *
 * Chain:
 *  - authenticateToken (router-level)
 *  - authorizeRole('admin','operator','biller')
 *  - attachBuildingScope()
 */
router.get(
  '/tenants/:tenant_id/period-end/:endDate',
  authorizeRole('admin', 'operator', 'biller'),
  attachBuildingScope(),
  async (req, res) => {
    try {
      const { tenant_id, endDate } = req.params;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
        return res.status(400).json({ error: 'Invalid endDate. Use YYYY-MM-DD.' });
      }

      const penaltyRatePct = Number(req.query.penalty_rate) || 0;

      const { meters, totals_by_type, grand_totals } = await computeBillingForTenant({
        tenantId: tenant_id,
        endDate,
        penaltyRatePct,
        restrictToBuildingIds: req.restrictToBuildingIds ?? null,
      });

      // Per-meter ROC% only
      const metersWithROC = [];
      for (const entry of meters) {
        if (entry?.error) { metersWithROC.push(entry); continue; }
        const meterId = entry?.meter?.meter_id;
        let rate_of_change_percent = null;
        try {
          const roc = await computeROCForMeter({ meterId, endDate });
          rate_of_change_percent = roc?.rate_of_change ?? null;
        } catch { rate_of_change_percent = null; }
        metersWithROC.push({ ...entry, rate_of_change_percent });
      }

      res.json({
        tenant_id,
        end_date: endDate,
        meters: metersWithROC,   // each meter has rate_of_change_percent
        totals_by_type,
        grand_totals,
        generated_at: getCurrentDateTime(),
      });
    } catch (err) {
      console.error('Billing (tenant) error:', err);
      res.status(err.status || 500).json({ error: err.message });
    }
  }
);

module.exports = router;
