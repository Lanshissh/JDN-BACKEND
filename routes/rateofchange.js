'use strict';

const express = require('express');
const router = express.Router();
const { Op } = require('sequelize');

const authenticateToken = require('../middleware/authenticateToken');
const authorizeRole     = require('../middleware/authorizeRole');
const authorizeUtilityRole = require('../middleware/authorizeUtilityRole');
const {
  authorizeBuildingParam,
  enforceRecordBuilding,
  attachBuildingScope
} = require('../middleware/authorizeBuilding');

const Meter    = require('../models/Meter');
const Stall    = require('../models/Stall');
const Building = require('../models/Building');
const Reading  = require('../models/Reading');

const {
  isYMD,
  getDisplayForRange,
  computeROCForMeter,
  getBuildingIdForRequest,
  ensureValidRange,
  splitWindowIntoN,
  getMaxReadingInPeriod,
  previousWindowSameLength,
  monthSpanFor
} = require('../utils/rocUtils');

/* Middleware */
router.use(authenticateToken);

/** ========== PER-METER ========== */
router.get(
  '/meters/:meter_id/period-start/:startDate/period-end/:endDate',
  authorizeRole('admin', 'operator', 'biller', 'reader'),
  authorizeUtilityRole({ roles: ['operator','biller','reader'] }),
  authorizeBuildingParam(),
  enforceRecordBuilding(getBuildingIdForRequest),
  async (req, res) => {
    try {
      const { meter_id, startDate, endDate } = req.params;
      if (!isYMD(startDate) || !isYMD(endDate)) {
        return res.status(400).json({ error: 'Invalid date(s). Use YYYY-MM-DD.' });
      }
      const result = await computeROCForMeter({ meterId: meter_id, startDate, endDate });
      return res.json(result);
    } catch (err) {
      const status = err?.status || 500;
      return res.status(status).json({ error: err?.message || 'Rate-of-change (meter) error' });
    }
  }
);

/** ========== PER-TENANT (all meters under tenant, within building scope) ========== */
router.get(
  '/tenants/:tenant_id/period-start/:startDate/period-end/:endDate',
  authorizeRole('admin', 'operator', 'biller', 'reader'),
  authorizeUtilityRole({ roles: ['operator','biller','reader'], anyOf: ['electric','water','lpg'] }),
  attachBuildingScope(),
  async (req, res) => {
    try {
      const { tenant_id, startDate, endDate } = req.params;
      if (!isYMD(startDate) || !isYMD(endDate)) {
        return res.status(400).json({ error: 'Invalid date(s). Use YYYY-MM-DD.' });
      }

      // 1) find all stalls for this tenant (within requester's building scope)
      const stalls = await Stall.findAll({
        where: { tenant_id, ...req.buildingWhere('building_id') },
        attributes: ['stall_id', 'building_id'],
        raw: true
      });
      if (!stalls.length) {
        return res.status(404).json({ error: 'No accessible stalls found for this tenant' });
      }

      // 2) meters under those stalls
      const stallIds = stalls.map(s => s.stall_id);
      const meters = await Meter.findAll({
        where: { stall_id: { [Op.in]: stallIds } },
        attributes: ['meter_id'],
        raw: true
      });
      if (!meters.length) {
        return res.status(404).json({ error: 'No meters found for this tenant (within your scope)' });
      }

      // 3) per-meter ROC (sheet-accurate) + collect errors inline
      const perMeter = [];
      for (const m of meters) {
        try {
          perMeter.push(await computeROCForMeter({ meterId: m.meter_id, startDate, endDate }));
        } catch (e) {
          perMeter.push({
            meter_id: m.meter_id,
            error: (e && e.message) || 'Failed to compute rate of change'
          });
        }
      }

      // 4) group by meter_type and compute group totals
      const { getTenantPeriods, groupMetersByType } = require('../utils/rocUtils');
      const grouped = groupMetersByType(perMeter);
      const { current, previous, anchor } = getTenantPeriods(startDate, endDate);

      // 5) respond
      return res.json({
        tenant_id,
        period: {
          current:  { start: current.start,  end: current.end  },
          previous: { start: previous.start, end: previous.end, month: previous.month },
          anchor:   { start: anchor.start,   end: anchor.end,   month: anchor.month }
        },
        groups: grouped
      });
    } catch (err) {
      const status = err?.status || 500;
      return res.status(status).json({ error: err?.message || 'Rate-of-change (tenant) error' });
    }
  }
);


/** ========== PER-BUILDING grouped by tenant ========== */
router.get(
  '/buildings/:building_id/period-start/:startDate/period-end/:endDate',
  authorizeRole('admin', 'operator', 'biller', 'reader'),
  authorizeUtilityRole({ roles: ['operator','biller','reader'], anyOf: ['electric','water','lpg'] }),
  authorizeBuildingParam(),
  async (req, res) => {
    try {
      const { building_id, startDate, endDate } = req.params;
      if (!isYMD(startDate) || !isYMD(endDate)) {
        return res.status(400).json({ error: 'Invalid date(s). Use YYYY-MM-DD.' });
      }

      const building = await Building.findOne({
        where: { building_id },
        attributes: ['building_id', 'building_name'],
        raw: true
      });
      if (!building) return res.status(404).json({ error: 'Building not found' });

      const stalls = await Stall.findAll({
        where: { building_id },
        attributes: ['stall_id', 'tenant_id'],
        raw: true
      });
      if (!stalls.length) return res.status(404).json({ error: 'No stalls found for this building' });

      // Group stall_ids by tenant_id
      const byTenant = new Map();
      for (const st of stalls) {
        const tId = st.tenant_id || 'UNASSIGNED';
        if (!byTenant.has(tId)) byTenant.set(tId, []);
        byTenant.get(tId).push(st.stall_id);
      }

      // local round helper (avoid importing)
      const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

      const tenantsOut = [];
      for (const [tenant_id, stallIds] of byTenant.entries()) {
        const meters = await Meter.findAll({
          where: { stall_id: { [Op.in]: stallIds } },
          attributes: ['meter_id'],
          raw: true
        });

        const perMeter = [];
        for (const m of meters) {
          try {
            perMeter.push(await computeROCForMeter({ meterId: m.meter_id, startDate, endDate }));
          } catch (e) {
            perMeter.push({
              meter_id: m.meter_id,
              error: (e && e.message) || 'Failed to compute rate of change'
            });
          }
        }

        // aggregate ONLY the two consumptions (no delta here)
        const aggCurrent  = perMeter.reduce((a, r) => a + (Number(r.current_consumption)  || 0), 0);
        const aggPrevious = perMeter.reduce((a, r) => a + (Number(r.previous_consumption) || 0), 0);
        const rate = aggPrevious > 0 ? Math.ceil(((aggCurrent - aggPrevious) / aggPrevious) * 100) : null;

        tenantsOut.push({
          tenant_id: tenant_id === 'UNASSIGNED' ? null : tenant_id,
          meters: perMeter,
          totals: {
            current_consumption:  round2(aggCurrent),
            previous_consumption: round2(aggPrevious),
            rate_of_change: rate
          }
        });
      }

      const { curr, prev } = getDisplayForRange(startDate, endDate);
      return res.json({
        building_id,
        building_name: building.building_name || null,
        period: {
          current:  { start: curr.start, end: curr.end },
          previous: { start: prev.start, end: prev.end }
        },
        tenants: tenantsOut
      });
    } catch (err) {
      const status = err?.status || 500;
      return res.status(status).json({ error: err?.message || 'Rate-of-change (building) error' });
    }
  }
);


/** ========== PER-BUILDING utility totals in the window (calendar-month baseline) ========== */
router.get(
  '/buildings/:building_id/period-start/:startDate/period-end/:endDate/monthly-comparison',
  authorizeRole('admin', 'operator', 'biller', 'reader'),
  authorizeUtilityRole({ roles: ['operator','biller','reader'], anyOf: ['electric','water','lpg'] }),
  authorizeBuildingParam(),
  async (req, res) => {
    try {
      const { building_id, startDate, endDate } = req.params;
      ensureValidRange(startDate, endDate);

      const building = await Building.findOne({
        where: { building_id },
        attributes: ['building_id', 'building_name', 'emin_con', 'wmin_con'],
        raw: true
      });
      if (!building) return res.status(404).json({ error: 'Building not found' });

      const stalls = await Stall.findAll({ where: { building_id }, attributes: ['stall_id'], raw: true });
      if (!stalls.length) return res.status(404).json({ error: 'No stalls found for this building' });

      const meters = await Meter.findAll({
        where: { stall_id: { [Op.in]: stalls.map(s => s.stall_id) } },
        attributes: ['meter_id', 'meter_type', 'meter_mult'],
        raw: true
      });
      if (!meters.length) return res.status(404).json({ error: 'No meters found for this building' });

      // >>> NEW: use full previous calendar month relative to endDate
      const previous = monthSpanFor(endDate, 1);

      const totals = { electric: 0, water: 0, lpg: 0 };

      for (const m of meters) {
        try {
          const [currMax, prevMax] = await Promise.all([
            getMaxReadingInPeriod(m.meter_id, startDate, endDate),                 // current window (user-specified)
            getMaxReadingInPeriod(m.meter_id, previous.start, previous.end)        // previous = full prev calendar month
          ]);
          if (!currMax || !prevMax) continue;

          const t = String(m.meter_type || '').toLowerCase();
          const raw = (Number(currMax.value) - Number(prevMax.value)) * (Number(m.meter_mult) || 1);

          let u = 0;
          if (t === 'electric') u = raw > 0 ? raw : (Number(building.emin_con) || 0);
          else if (t === 'water') u = raw > 0 ? raw : (Number(building.wmin_con) || 0);
          else if (t === 'lpg') u = raw > 0 ? raw : 0;

          totals[t] += Number(u) || 0;
        } catch { /* skip meter on error */ }
      }

      const round2 = n => Math.round(n * 100) / 100;
      return res.json({
        building_id,
        building_name: building.building_name || null,
        period: { start: startDate, end: endDate },
        totals: {
          electric: round2(totals.electric),
          water:    round2(totals.water),
          lpg:      round2(totals.lpg)
        }
      });
    } catch (err) {
      const status = err?.status || 500;
      return res.status(status).json({ error: err?.message || 'Building monthly comparison error' });
    }
  }
);


/** ========== PER-BUILDING — 4 consecutive calendar months (calendar-month baseline, like monthly-comparison) ========== */
router.get(
  '/buildings/:building_id/period-start/:startDate/period-end/:endDate/quarterly-comparison',
  authorizeRole('admin', 'operator', 'biller', 'reader'),
  authorizeUtilityRole({ roles: ['operator','biller','reader'], anyOf: ['electric','water','lpg'] }),
  authorizeBuildingParam(),
  async (req, res) => {
    try {
      const { building_id, startDate, endDate } = req.params;
      // Validate window (we don't slice it; we just use endDate's month as the last month)
      ensureValidRange(startDate, endDate);

      const building = await Building.findOne({
        where: { building_id },
        attributes: ['building_id', 'building_name', 'emin_con', 'wmin_con'],
        raw: true
      });
      if (!building) return res.status(404).json({ error: 'Building not found' });

      const stalls = await Stall.findAll({ where: { building_id }, attributes: ['stall_id'], raw: true });
      if (!stalls.length) return res.status(404).json({ error: 'No stalls found for this building' });

      const meters = await Meter.findAll({
        where: { stall_id: { [Op.in]: stalls.map(s => s.stall_id) } },
        attributes: ['meter_id','meter_type','meter_mult'],
        raw: true
      });
      if (!meters.length) return res.status(404).json({ error: 'No meters found for this building' });

      // ---- Build the 4 calendar months ending at endDate's month ----
      // M4 = month(endDate), M3 = −1, M2 = −2, M1 = −3
      const months = [3,2,1,0].map(back => {
        const m = monthSpanFor(endDate, back);             // current month period
        const p = monthSpanFor(endDate, back + 1);         // previous month period
        return {
          label: m.month,                                  // "YYYY-MM"
          start: m.start,
          end:   m.end,
          previous: { month: p.month, start: p.start, end: p.end },
          totals: { electric: 0, water: 0, lpg: 0 }
        };
      });

      // ---- Aggregate per meter for each month using "monthly-comparison" math ----
      for (const m of meters) {
        const type = String(m.meter_type || '').toLowerCase();
        const mult = Number(m.meter_mult) || 1;

        for (const slot of months) {
          try {
            const [currMax, prevMax] = await Promise.all([
              getMaxReadingInPeriod(m.meter_id, slot.start, slot.end),
              getMaxReadingInPeriod(m.meter_id, slot.previous.start, slot.previous.end)
            ]);
            if (!currMax || !prevMax) continue;

            const raw = (Number(currMax.value) - Number(prevMax.value)) * mult;

            let units = 0;
            if (type === 'electric') units = raw > 0 ? raw : (Number(building.emin_con) || 0);
            else if (type === 'water') units = raw > 0 ? raw : (Number(building.wmin_con) || 0);
            else if (type === 'lpg') units = raw > 0 ? raw : 0;

            slot.totals[type] += Number(units) || 0;
          } catch {
            // skip this meter for this slot on error
          }
        }
      }

      // Round totals per month
      months.forEach(slot => {
        slot.totals.electric = Math.round(slot.totals.electric * 100) / 100;
        slot.totals.water    = Math.round(slot.totals.water    * 100) / 100;
        slot.totals.lpg      = Math.round(slot.totals.lpg      * 100) / 100;
      });

      const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

// Sum across the 4 months
const totals_all = months.reduce((acc, m) => {
  acc.electric += Number(m.totals.electric) || 0;
  acc.water    += Number(m.totals.water)    || 0;
  acc.lpg      += Number(m.totals.lpg)      || 0;
  return acc;
}, { electric: 0, water: 0, lpg: 0 });

// Round and add an overall “all utilities” sum too
totals_all.electric = round2(totals_all.electric);
totals_all.water    = round2(totals_all.water);
totals_all.lpg      = round2(totals_all.lpg);
totals_all.all_utilities = round2(
  totals_all.electric + totals_all.water + totals_all.lpg
);

// Then include in the response:
return res.json({
  building_id,
  building_name: building.building_name || null,
  window: { start: startDate, end: endDate },
  months,
  totals_all                 // 👈 new grand total block at the end
});
    } catch (err) {
      const status = err?.status || 500;
      return res.status(status).json({ error: err?.message || 'Quarterly comparison error' });
    }
  }
);

/** ========== PER-BUILDING — Yearly comparison (12 calendar months, prev = full previous month) ========== */
router.get(
  '/buildings/:building_id/year/:year/yearly-comparison',
  authorizeRole('admin', 'operator', 'biller', 'reader'),
  authorizeUtilityRole({ roles: ['operator','biller','reader'], anyOf: ['electric','water','lpg'] }),
  authorizeBuildingParam(),
  async (req, res) => {
    try {
      const { building_id, year } = req.params;
      if (!/^\d{4}$/.test(String(year))) {
        return res.status(400).json({ error: 'Invalid year. Use YYYY.' });
      }
      const Y = Number(year);

      const building = await Building.findOne({
        where: { building_id },
        attributes: ['building_id', 'building_name', 'emin_con', 'wmin_con'],
        raw: true
      });
      if (!building) return res.status(404).json({ error: 'Building not found' });

      const stalls = await Stall.findAll({ where: { building_id }, attributes: ['stall_id'], raw: true });
      if (!stalls.length) return res.status(404).json({ error: 'No stalls found for this building' });

      const meters = await Meter.findAll({
        where: { stall_id: { [Op.in]: stalls.map(s => s.stall_id) } },
        attributes: ['meter_id', 'meter_type', 'meter_mult'],
        raw: true
      });
      if (!meters.length) return res.status(404).json({ error: 'No meters found for this building' });

      // --- helpers to build month spans in UTC ---
      const dtUTC = (y, m0, d) => new Date(Date.UTC(y, m0, d));
      const ymd = d => d.toISOString().slice(0,10);
      function monthSpan(y, m0) { // m0: 0=Jan..11=Dec
        const start = dtUTC(y, m0, 1);
        const end   = dtUTC(y, m0 + 1, 0);
        return { start: ymd(start), end: ymd(end), month: `${y}-${String(m0+1).padStart(2,'0')}` };
      }
      function previousMonthSpan(y, m0) {
        // previous month, possibly y-1 if m0==0
        const prevY  = m0 === 0 ? y - 1 : y;
        const prevM0 = m0 === 0 ? 11    : m0 - 1;
        return monthSpan(prevY, prevM0);
      }

      // Build 12 months for the given year (Jan..Dec), with their previous-month baselines
      const months = [];
      for (let m0 = 0; m0 < 12; m0++) {
        const curr = monthSpan(Y, m0);
        const prev = previousMonthSpan(Y, m0);
        months.push({
          label: curr.month,        // "YYYY-MM"
          start: curr.start,
          end:   curr.end,
          previous: { month: prev.month, start: prev.start, end: prev.end },
          totals: { electric: 0, water: 0, lpg: 0 }
        });
      }

      // Aggregate exactly like monthly-comparison, for each month independently
      for (const m of meters) {
        const type = String(m.meter_type || '').toLowerCase();
        const mult = Number(m.meter_mult) || 1;

        for (const slot of months) {
          try {
            const [currMax, prevMax] = await Promise.all([
              getMaxReadingInPeriod(m.meter_id, slot.start, slot.end),
              getMaxReadingInPeriod(m.meter_id, slot.previous.start, slot.previous.end)
            ]);
            if (!currMax || !prevMax) continue;

            const raw = (Number(currMax.value) - Number(prevMax.value)) * mult;

            let units = 0;
            if (type === 'electric') units = raw > 0 ? raw : (Number(building.emin_con) || 0);
            else if (type === 'water') units = raw > 0 ? raw : (Number(building.wmin_con) || 0);
            else if (type === 'lpg') units = raw > 0 ? raw : 0;

            slot.totals[type] += Number(units) || 0;
          } catch {
            // skip this meter on error for this month
          }
        }
      }

      // Round per month
      months.forEach(slot => {
        slot.totals.electric = Math.round(slot.totals.electric * 100) / 100;
        slot.totals.water    = Math.round(slot.totals.water    * 100) / 100;
        slot.totals.lpg      = Math.round(slot.totals.lpg      * 100) / 100;
      });

      // Grand totals across the year
      const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
      const totals_all = months.reduce((acc, s) => {
        acc.electric += Number(s.totals.electric) || 0;
        acc.water    += Number(s.totals.water)    || 0;
        acc.lpg      += Number(s.totals.lpg)      || 0;
        return acc;
      }, { electric: 0, water: 0, lpg: 0 });
      totals_all.electric = round2(totals_all.electric);
      totals_all.water    = round2(totals_all.water);
      totals_all.lpg      = round2(totals_all.lpg);
      totals_all.all_utilities = round2(totals_all.electric + totals_all.water + totals_all.lpg);

      return res.json({
        building_id,
        building_name: building.building_name || null,
        year: Y,
        months,          // 12 rows, Jan..Dec
        totals_all       // annual sums per utility + combined
      });
    } catch (err) {
      const status = err?.status || 500;
      return res.status(status).json({ error: err?.message || 'Yearly comparison error' });
    }
  }
);



module.exports = router;
