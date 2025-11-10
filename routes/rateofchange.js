// routes/rateofchange.js (only the changed routes shown)
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
  getMaxReadingInPeriod
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

      const stalls = await Stall.findAll({
        where: { tenant_id, ...req.buildingWhere('building_id') },
        attributes: ['stall_id', 'building_id'],
        raw: true
      });
      if (!stalls.length) {
        return res.status(404).json({ error: 'No accessible stalls found for this tenant' });
      }

      const stallIds = stalls.map(s => s.stall_id);
      const meters = await Meter.findAll({
        where: { stall_id: { [Op.in]: stallIds } },
        attributes: ['meter_id'],
        raw: true
      });
      if (!meters.length) {
        return res.status(404).json({ error: 'No meters found for this tenant (within your scope)' });
      }

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

      const { curr, prev } = getDisplayForRange(startDate, endDate);
      return res.json({
        tenant_id,
        period: { current: { start: curr.start, end: curr.end }, previous: { start: prev.start, end: prev.end } },
        meters: perMeter
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
            perMeter.push({ meter_id: m.meter_id, error: (e && e.message) || 'Failed to compute rate of change' });
          }
        }

        const aggCurrent  = perMeter.reduce((a, r) => a + (Number(r.current_consumption)  || 0), 0);
        const aggPrevious = perMeter.reduce((a, r) => a + (Number(r.previous_consumption) || 0), 0);
        const rate = aggPrevious > 0 ? Math.ceil(((aggCurrent - aggPrevious) / aggPrevious) * 100) : null;

        tenantsOut.push({
          tenant_id: tenant_id === 'UNASSIGNED' ? null : tenant_id,
          meters: perMeter,
          totals: {
            current_consumption: round(aggCurrent, 2),
            previous_consumption: round(aggPrevious, 2),
            rate_of_change: rate
          }
        });
      }

      const { curr, prev } = getDisplayForRange(startDate, endDate);
      return res.json({
        building_id,
        building_name: building.building_name || null,
        period: { current: { start: curr.start, end: curr.end }, previous: { start: prev.start, end: prev.end } },
        tenants: tenantsOut
      });
    } catch (err) {
      const status = err?.status || 500;
      return res.status(status).json({ error: err?.message || 'Rate-of-change (building) error' });
    }
  }
);

/** ========== PER-BUILDING utility totals in the window (no ROC, just totals) ========== */
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

      const { prev } = getDisplayForRange(startDate, endDate);
      const totals = { electric: 0, water: 0, lpg: 0 };

      for (const m of meters) {
        try {
          const [currMax, prevMax] = await Promise.all([
            getMaxReadingInPeriod(m.meter_id, startDate, endDate),
            getMaxReadingInPeriod(m.meter_id, prev.start, prev.end)
          ]);
          if (!currMax || !prevMax) continue;

          // reuse unit calc from utils
          const units = require('../utils/rocUtils').computeROCForMeter
            ? null // silence linter, we won't call compute here to avoid re-fetching relations
            : null;

          // Inline quick compute to avoid extra lookups:
          const t = String(m.meter_type || '').toLowerCase();
          const raw = (Number(currMax.value) - Number(prevMax.value)) * (Number(m.meter_mult) || 1);
          let u = 0;
          if (t === 'electric') u = raw > 0 ? raw : (Number(building.emin_con) || 0);
          else if (t === 'water') u = raw > 0 ? raw : (Number(building.wmin_con) || 0);
          else if (t === 'lpg') u = raw > 0 ? raw : 0;

          totals[t] += Number(u) || 0;
        } catch { /* skip */ }
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

/** ========== PER-BUILDING — Split the given window into 4 consecutive slices ========== */
router.get(
  '/buildings/:building_id/period-start/:startDate/period-end/:endDate/quarterly-comparison',
  authorizeRole('admin', 'operator', 'biller', 'reader'),
  authorizeUtilityRole({ roles: ['operator','biller','reader'], anyOf: ['electric','water','lpg'] }),
  authorizeBuildingParam(),
  async (req, res) => {
    try {
      const { building_id, startDate, endDate } = req.params;
      const { start, end } = ensureValidRange(startDate, endDate);

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

      // Build 4 consecutive slices that fully cover [start,end]
      const slices = splitWindowIntoN(start, end, 4).map(p => ({
        ...p,
        label: p.end.slice(0,7) // YYYY-MM label by end month
      }));

      // For per-slice unit calc we need an anchor slice before the first
      const first = slices[0];
      const anchor = previousWindowSameLength(first.start, first.end);

      // Initialize totals
      const totalsPerSlice = slices.map(s => ({ label: s.label, start: s.start, end: s.end, totals: { electric: 0, water: 0, lpg: 0 } }));

      // Aggregate per meter across slices using last index within each slice
      for (const m of meters) {
        try {
          // Fetch maxima: anchor + all slices
          const maxes = await Promise.all([
            getMaxReadingInPeriod(m.meter_id, anchor.start, anchor.end),
            ...slices.map(s => getMaxReadingInPeriod(m.meter_id, s.start, s.end))
          ]);

          for (let i = 0; i < slices.length; i++) {
            const prevMax = maxes[i];       // anchor for i=0, or previous slice
            const currMax = maxes[i + 1];   // current slice
            if (!prevMax || !currMax) continue;

            const t = String(m.meter_type || '').toLowerCase();
            const raw = (Number(currMax.value) - Number(prevMax.value)) * (Number(m.meter_mult) || 1);
            let u = 0;
            if (t === 'electric') u = raw > 0 ? raw : (Number(building.emin_con) || 0);
            else if (t === 'water') u = raw > 0 ? raw : (Number(building.wmin_con) || 0);
            else if (t === 'lpg') u = raw > 0 ? raw : 0;

            totalsPerSlice[i].totals[t] += Number(u) || 0;
          }
        } catch { /* continue */}
      }

      // Round out
      totalsPerSlice.forEach(s => {
        s.totals.electric = Math.round(s.totals.electric * 100) / 100;
        s.totals.water    = Math.round(s.totals.water    * 100) / 100;
        s.totals.lpg      = Math.round(s.totals.lpg      * 100) / 100;
      });

      return res.json({
        building_id,
        building_name: building.building_name || null,
        slices: totalsPerSlice
      });
    } catch (err) {
      const status = err?.status || 500;
      return res.status(status).json({ error: err?.message || 'Quarterly comparison error' });
    }
  }
);

module.exports = router;
