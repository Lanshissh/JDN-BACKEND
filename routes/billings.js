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
 * BUILDING (standard) — grouped by tenant, ROC only per meter (clean output)
 * ========================================================================== */
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

      const { meters } = await computeBillingForBuilding({
        buildingId: building_id,
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
        const tenantId   = entry?.tenant?.tenant_id ?? null;
        const tenantName = entry?.tenant?.tenant_name ?? null;

        let rate_of_change_pct = null;
        let prev_consumed_kwh  = null;
        try {
          const roc = await computeROCForMeter({ meterId, endDate });
          rate_of_change_pct = roc?.rate_of_change ?? null;
          prev_consumed_kwh  = roc?.previous_consumption ?? null;
        } catch {}

        const prevIdx   = Number(entry?.indices?.prev_index ?? 0);
        const currIdx   = Number(entry?.indices?.curr_index ?? 0);
        const consumed  = Number(entry?.totals?.consumption ?? 0);
        const base      = Number(entry?.totals?.base ?? 0);
        const vat       = Number(entry?.billing?.vat ?? 0);
        const totalAmt  = Number(entry?.totals?.total ?? 0);

        const utilityRate = consumed > 0 ? +(base / consumed).toFixed(6) : null; // equals system rate in non-markup
        const vatRate     = base > 0 ? +(vat / base).toFixed(4) : null;

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

      // group by tenant
      const tenantsMap = new Map();
      for (const r of rows) {
        const tkey = `${r.tenant_name ?? 'UNKNOWN'}::${r.tenant_id ?? 'NA'}`;
        if (!tenantsMap.has(tkey)) {
          tenantsMap.set(tkey, { tenant_id: r.tenant_id ?? null, tenant_name: r.tenant_name ?? null, rows: [] });
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
        end_date: endDate,
        tenants,
        totals,
        generated_at: getCurrentDateTime(),
      });
    } catch (err) {
      console.error('Billing (building) clean output error:', err);
      res.status(err.status || 500).json({ error: err.message });
    }
  }
);

/* =============================================================================
 * BUILDING (with markup) — grouped by tenant; show system_rate & markup_rate
 * ========================================================================== */
router.get(
  '/with-markup/buildings/:building_id/period-end/:endDate',
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

      const { meters } = await computeBillingForBuildingWithMarkup({
        buildingId: building_id,
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
        const tenantId   = entry?.tenant?.tenant_id ?? null;
        const tenantName = entry?.tenant?.tenant_name ?? null;

        let rate_of_change_pct = null;
        let prev_consumed_kwh  = null;
        try {
          const roc = await computeROCForMeter({ meterId, endDate });
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
          tenant_id: tenantId,
          tenant_name: tenantName,
          meter_no: meterSN,
          meter_id: meterId,
          mult: mult,
          reading_previous: prevIdx,
          reading_present: currIdx,
          consumed_kwh: consumed,
          utility_rate: utilityRate,
          markup_rate: markupRate,
          system_rate: systemRate, // = utility_rate + markup_rate
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

      const tenantsMap = new Map();
      for (const r of rows) {
        const tkey = `${r.tenant_name ?? 'UNKNOWN'}::${r.tenant_id ?? 'NA'}`;
        if (!tenantsMap.has(tkey)) {
          tenantsMap.set(tkey, { tenant_id: r.tenant_id ?? null, tenant_name: r.tenant_name ?? null, rows: [] });
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
        end_date: endDate,
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
 * METER (standard)
 * ========================================================================== */
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
        restrictToBuildingIds: req.restrictToBuildingIds ?? null,
      });

      const roc = await computeROCForMeter({ meterId: meter_id, endDate });
      const rate_of_change_percent = roc?.rate_of_change ?? null;

      const penalty_rate = (Number(penaltyRatePct) >= 1) ? Number(penaltyRatePct) / 100 : Number(penaltyRatePct) || 0;
      const base = Number(result?.billing?.base ?? 0);
      const vat  = Number(result?.billing?.vat ?? 0);
      const wt   = Number(result?.billing?.wt ?? 0);
      const vat_rate = base > 0 ? +(vat / base).toFixed(4) : null;
      const wt_rate  = vat > 0  ? +(wt  / vat ).toFixed(4) : null;

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
        generated_at: getCurrentDateTime()
      });
    } catch (err) {
      console.error('Billing (meter) error:', err);
      res.status(err.status || 500).json({ error: err.message });
    }
  }
);

/* =============================================================================
 * METER (with markup)
 * ========================================================================== */
router.get(
  '/with-markup/meters/:meter_id/period-end/:endDate',
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

      const result = await computeBillingForMeterWithMarkup({
        meterId: meter_id,
        endDate,
        penaltyRatePct,
        restrictToBuildingIds: req.restrictToBuildingIds ?? null,
      });

      const roc = await computeROCForMeter({ meterId: meter_id, endDate });
      const rate_of_change_percent = roc?.rate_of_change ?? null;

      const penalty_rate = (Number(penaltyRatePct) >= 1) ? Number(penaltyRatePct) / 100 : Number(penaltyRatePct) || 0;
      const base = Number(result?.billing?.base ?? 0);
      const vat  = Number(result?.billing?.vat ?? 0);
      const wt   = Number(result?.billing?.wt ?? 0);
      const vat_rate = base > 0 ? +(vat / base).toFixed(4) : null;
      const wt_rate  = vat > 0  ? +(wt  / vat ).toFixed(4) : null;

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
        generated_at: getCurrentDateTime()
      });
    } catch (err) {
      console.error('Billing (meter + markup) error:', err);
      res.status(err.status || 500).json({ error: err.message });
    }
  }
);

/* =============================================================================
 * TENANT (standard)
 * ========================================================================== */
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
        meters: metersWithROC,
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

/* =============================================================================
 * TENANT (with markup)
 * ========================================================================== */
router.get(
  '/with-markup/tenants/:tenant_id/period-end/:endDate',
  authorizeRole('admin', 'operator', 'biller'),
  attachBuildingScope(),
  async (req, res) => {
    try {
      const { tenant_id, endDate } = req.params;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
        return res.status(400).json({ error: 'Invalid endDate. Use YYYY-MM-DD.' });
      }

      const penaltyRatePct = Number(req.query.penalty_rate) || 0;

      const { meters, totals_by_type, grand_totals } = await computeBillingForTenantWithMarkup({
        tenantId: tenant_id,
        endDate,
        penaltyRatePct,
        restrictToBuildingIds: req.restrictToBuildingIds ?? null,
      });

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
