// routes/rateofchange.js
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

// Models used purely for listing/IDs in routes
const Meter    = require('../models/Meter');
const Stall    = require('../models/Stall');
const Building = require('../models/Building');
const Reading  = require('../models/Reading');


// Utils (all helpers + core compute live here now)
const {
  sendErr,
  isYMD,
  getDisplayRollingPeriods,
  computeROCForMeter,
  getBuildingIdForRequest
} = require('../utils/rocUtils');

/* Middleware */
router.use(authenticateToken);

/**
 * PER-METER
 * GET /rateofchange/meters/:meter_id/period-end/:endDate
 */
router.get(
  '/meters/:meter_id/period-end/:endDate',
  authorizeRole('admin', 'operator', 'biller', 'reader'),
  authorizeUtilityRole({ roles: ['operator','biller','reader'] }),
  authorizeBuildingParam(),
  enforceRecordBuilding(getBuildingIdForRequest),
  async (req, res) => {
    try {
      const { meter_id, endDate } = req.params;
      if (!isYMD(endDate)) {
        return res.status(400).json({ error: 'Invalid endDate. Use YYYY-MM-DD.' });
      }
      const result = await computeROCForMeter({ meterId: meter_id, endDate });
      return res.json(result);
    } catch (err) {
      sendErr(res, err, 'Rate-of-change (meter) error');
    }
  }
);

/**
 * PER-TENANT (lists all meters; shows stall per meter)
 * GET /rateofchange/tenants/:tenant_id/period-end/:endDate
 */
router.get(
  '/tenants/:tenant_id/period-end/:endDate',
  authorizeRole('admin', 'operator', 'biller', 'reader'),
  authorizeUtilityRole({
    roles: ['operator','biller','reader'],
    anyOf: ['electric','water','lpg'],
  }),
  attachBuildingScope(),
  async (req, res) => {
    try {
      const { tenant_id, endDate } = req.params;
      if (!isYMD(endDate)) {
        return res.status(400).json({ error: 'Invalid endDate. Use YYYY-MM-DD.' });
      }

      const stalls = await Stall.findAll({
        where: {
          tenant_id,
          ...req.buildingWhere('building_id'),
        },
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
          perMeter.push(await computeROCForMeter({ meterId: m.meter_id, endDate }));
        } catch (e) {
          perMeter.push({
            meter_id: m.meter_id,
            error: (e && e.message) || 'Failed to compute rate of change'
          });
        }
      }

      const display = getDisplayRollingPeriods(endDate);
      return res.json({
        tenant_id,
        period: { current: display.curr, previous: display.prev },
        meters: perMeter
      });
    } catch (err) {
      sendErr(res, err, 'Rate-of-change (tenant) error');
    }
  }
);

/**
 * PER-BUILDING grouped by tenant
 * GET /rateofchange/buildings/:building_id/period-end/:endDate
 */
router.get(
  '/buildings/:building_id/period-end/:endDate',
  authorizeRole('admin', 'operator', 'biller', 'reader'),
  authorizeUtilityRole({
    roles: ['operator','biller','reader'],
    anyOf: ['electric','water','lpg'],
  }),
  authorizeBuildingParam(),
  async (req, res) => {
    try {
      const { building_id, endDate } = req.params;
      if (!isYMD(endDate)) {
        return res.status(400).json({ error: 'Invalid endDate. Use YYYY-MM-DD.' });
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
      if (!stalls.length) {
        return res.status(404).json({ error: 'No stalls found for this building' });
      }

      // Group stall_ids by tenant_id
      const byTenant = new Map();
      for (const st of stalls) {
        const tId = st.tenant_id || 'UNASSIGNED';
        if (!byTenant.has(tId)) byTenant.set(tId, []);
        byTenant.get(tId).push(st.stall_id);
      }

      // Load meters per tenant group
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
            perMeter.push(await computeROCForMeter({ meterId: m.meter_id, endDate }));
          } catch (e) {
            perMeter.push({
              meter_id: m.meter_id,
              error: (e && e.message) || 'Failed to compute rate of change'
            });
          }
        }

        const aggCurrent  = perMeter.reduce((a, r) => a + (Number(r.current_consumption)  || 0), 0);
        const aggPrevious = perMeter.reduce((a, r) => a + (Number(r.previous_consumption) || 0), 0);
        const rate = aggPrevious > 0 ? Math.ceil(((aggCurrent - aggPrevious) / aggPrevious) * 100) : null;

        tenantsOut.push({
          tenant_id: tenant_id === 'UNASSIGNED' ? null : tenant_id,
          meters: perMeter,
          totals: {
            current_consumption: Math.round(aggCurrent * 100) / 100,
            previous_consumption: Math.round(aggPrevious * 100) / 100,
            rate_of_change: rate
          }
        });
      }

      const display = getDisplayRollingPeriods(endDate);
      return res.json({
        building_id,
        building_name: building.building_name || null,
        period: { current: display.curr, previous: display.prev },
        tenants: tenantsOut
      });
    } catch (err) {
      sendErr(res, err, 'Rate-of-change (building) error');
    }
  }
);

/**
 * PER-BUILDING utility totals (current period only)
 * GET /roc/buildings/:building_id/period-end/:endDate/comparison
 */
router.get(
  '/buildings/:building_id/period-end/:endDate/monthly-comparison',
  authorizeRole('admin', 'operator', 'biller', 'reader'),
  authorizeUtilityRole({
    roles: ['operator','biller','reader'],
    anyOf: ['electric','water','lpg'],
  }),
  authorizeBuildingParam(),
  async (req, res) => {
    try {
      const { building_id, endDate } = req.params;
      if (!isYMD(endDate)) {
        return res.status(400).json({ error: 'Invalid endDate. Use YYYY-MM-DD.' });
      }

      // Verify building exists
      const building = await Building.findOne({
        where: { building_id },
        attributes: ['building_id', 'building_name'],
        raw: true
      });
      if (!building) return res.status(404).json({ error: 'Building not found' });

      // Find stalls in building
      const stalls = await Stall.findAll({
        where: { building_id },
        attributes: ['stall_id'],
        raw: true
      });
      if (!stalls.length) {
        return res.status(404).json({ error: 'No stalls found for this building' });
      }

      // Collect meters on those stalls
      const stallIds = stalls.map(s => s.stall_id);
      const meters = await Meter.findAll({
        where: { stall_id: { [Op.in]: stallIds } },
        attributes: ['meter_id'],
        raw: true
      });
      if (!meters.length) {
        return res.status(404).json({ error: 'No meters found for this building' });
      }

      // Sum current consumption by utility
      const totals = { electric: 0, water: 0, lpg: 0 };
      for (const m of meters) {
        try {
          const r = await computeROCForMeter({ meterId: m.meter_id, endDate });
          const key = String(r.meter_type || '').toLowerCase();
          if (totals.hasOwnProperty(key)) {
            totals[key] += Number(r.current_consumption) || 0;
          }
        } catch (_) {
          // Skip meter errors but continue aggregating others
        }
      }

      // Round to 2 decimals
      const round2 = n => Math.round(n * 100) / 100;
      const display = getDisplayRollingPeriods(endDate);

      return res.json({
        building_id,
        building_name: building.building_name || null,
        period: { current: display.curr }, // display window only
        totals: {
          electric: round2(totals.electric),
          water: round2(totals.water),
          lpg: round2(totals.lpg),
        }
      });
    } catch (err) {
      sendErr(res, err, 'Rate-of-change (building utility totals) error');
    }
  }
);


/**
 * PER-BUILDING — Four consecutive 21→20 periods (same logic as monthly; just 4x)
 * GET /roc/buildings/:building_id/period-end/:endDate/four-month-comparison
 *
 * If :endDate = 2025-05-20, periods (oldest→latest):
 *  - 2025-01-21 .. 2025-02-20
 *  - 2025-02-21 .. 2025-03-20
 *  - 2025-03-21 .. 2025-04-20
 *  - 2025-04-21 .. 2025-05-20
 * (Uses an anchor period 2024-12-21 .. 2025-01-20 to compute the first delta.)
 */
router.get(
  '/buildings/:building_id/period-end/:endDate/quarterly-comparison',
  authorizeRole('admin', 'operator', 'biller', 'reader'),
  authorizeUtilityRole({ roles: ['operator','biller','reader'], anyOf: ['electric','water','lpg'] }),
  authorizeBuildingParam(),
  async (req, res) => {
    try {
      const { building_id, endDate } = req.params;
      if (!isYMD(endDate)) {
        return res.status(400).json({ error: 'Invalid endDate. Use YYYY-MM-DD.' });
      }

      // ---------- date helpers (21→20 periods) ----------
      const fromYMD = (s) => new Date(s + 'T00:00:00Z');
      const ymd = (d) => d.toISOString().slice(0,10);
      const setUTC = (y, m0, d) => new Date(Date.UTC(y, m0, d));
      const addMonthsUTC = (date, delta) => {
        const y = date.getUTCFullYear(), m = date.getUTCMonth(), d = date.getUTCDate();
        const tm = m + delta, ty = y + Math.floor(tm / 12), mm = (tm % 12 + 12) % 12;
        // clamp to end-of-month if needed (we only ever set to 20 or 21 below)
        const last = new Date(Date.UTC(ty, mm + 1, 0)).getUTCDate();
        return new Date(Date.UTC(ty, mm, Math.min(d, last)));
      };

      // Build a 21→20 period ending at :endDate (assumed to be the 20th for your cycle)
      function periodFromEnd(endYMD) {
        const end = fromYMD(endYMD);               // e.g., 2025-05-20
        const prev = addMonthsUTC(end, -1);        // previous month, same day
        const start = setUTC(prev.getUTCFullYear(), prev.getUTCMonth(), 21);
        return { start: ymd(start), end: ymd(end) };
      }

      // Previous 21→20 period: shift both bounds back one month, keep days 21/20
      function prevPeriod(p) {
        const s = fromYMD(p.start); // day 21
        const e = fromYMD(p.end);   // day 20
        const prevStart = addMonthsUTC(s, -1); // still day 21
        const prevEnd   = addMonthsUTC(e, -1); // still day 20
        return { start: ymd(prevStart), end: ymd(prevEnd) };
      }

      // ---------- models ----------
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

      // ---------- DB + units helpers ----------
     async function getMaxReadingInPeriod(meter_id, startYMD, endYMD) {
  const row = await Reading.findOne({
    where: {
      meter_id,
      lastread_date: { [Op.gte]: startYMD, [Op.lte]: endYMD },
    },
    order: [['lastread_date', 'DESC']],
    attributes: ['reading_value', 'lastread_date'],
    raw: true
  });
  return row ? { value: Number(row.reading_value) || 0, date: row.lastread_date } : null;
}

      const round2 = (n) => Math.round(n * 100) / 100;
      const LPG_MIN_CON = 0;

      function computeUnits(type, mult, prevIdx, currIdx) {
        const raw = ((Number(currIdx) - Number(prevIdx)) * (Number(mult) || 1));
        const t = String(type || '').toLowerCase();
        if (t === 'electric') {
          const min = Number(building.emin_con) || 0;
          return raw > 0 ? raw : min;
        }
        if (t === 'water') {
          const min = Number(building.wmin_con) || 0;
          return raw > 0 ? raw : min;
        }
        if (t === 'lpg') {
          return raw > 0 ? raw : LPG_MIN_CON;
        }
        throw Object.assign(new Error(`Unsupported meter type: ${t}`), { status: 400 });
      }

      // ---------- build the four periods (21→20) + anchor ----------
      const p4 = periodFromEnd(endDate); // latest
      const p3 = prevPeriod(p4);
      const p2 = prevPeriod(p3);
      const p1 = prevPeriod(p2);        // oldest returned
      const anchor = prevPeriod(p1);    // for p1 delta

      const periods = [
        { ...p1, prev: anchor },
        { ...p2, prev: p1 },
        { ...p3, prev: p2 },
        { ...p4, prev: p3 },
      ].map(p => ({
        ...p,
        month: p.end.slice(0, 7),       // label by end month (e.g., "2025-05")
        totals: { electric: 0, water: 0, lpg: 0 },
      }));

      // ---------- aggregate per meter across the four periods ----------
      for (const m of meters) {
        try {
          const [aMax, p1Max, p2Max, p3Max, p4Max] = await Promise.all([
            getMaxReadingInPeriod(m.meter_id, anchor.start, anchor.end),
            getMaxReadingInPeriod(m.meter_id, p1.start, p1.end),
            getMaxReadingInPeriod(m.meter_id, p2.start, p2.end),
            getMaxReadingInPeriod(m.meter_id, p3.start, p3.end),
            getMaxReadingInPeriod(m.meter_id, p4.start, p4.end),
          ]);

          const pairs = [
            [aMax, p1Max], // delta for p1
            [p1Max, p2Max],// delta for p2
            [p2Max, p3Max],// delta for p3
            [p3Max, p4Max],// delta for p4
          ];

          for (let i = 0; i < periods.length; i++) {
            const [prevMax, currMax] = pairs[i];
            if (prevMax && currMax) {
              const units = computeUnits(
                m.meter_type,
                m.meter_mult,
                prevMax.value,
                currMax.value
              );
              const key = String(m.meter_type || '').toLowerCase();
              periods[i].totals[key] += Number(units) || 0;
            }
          }
        } catch {
          // continue even if a meter has an issue
        }
      }

      // finalize totals
      periods.forEach(p => {
        p.totals.electric = round2(p.totals.electric);
        p.totals.water    = round2(p.totals.water);
        p.totals.lpg      = round2(p.totals.lpg);
      });

      // ensure chronological order (oldest → latest)
      periods.sort((a,b) => a.month.localeCompare(b.month));

      return res.json({
        building_id,
        building_name: building.building_name || null,
        four_months: {
          periods: periods.map(p => ({
            month: p.month,
            start: p.start,
            end:   p.end,
            totals: {
              electric: p.totals.electric,
              water:    p.totals.water,
              lpg:      p.totals.lpg
            }
          }))
        }
      });
    } catch (err) {
      sendErr(res, err, 'Four-month comparison (21→20) error');
    }
  }
);


/**
 * YEARLY COMPARISON — 12 monthly 21→20 periods for a given year (YYYY)
 * GET /roc/buildings/:building_id/year/:year/yearly-comparison
 *
 * Example for year=2025, periods (oldest→latest):
 *  2024-12-21..2025-01-20, 2025-01-21..2025-02-20, ... , 2025-11-21..2025-12-20
 * Uses an anchor window (2024-11-21..2024-12-20) to compute January’s delta.
 */
router.get(
  '/buildings/:building_id/year/:year/yearly-comparison',
  authorizeRole('admin', 'operator', 'biller', 'reader'),
  authorizeUtilityRole({ roles: ['operator','biller','reader'], anyOf: ['electric','water','lpg'] }),
  authorizeBuildingParam(),
  async (req, res) => {
    try {
      const { building_id, year } = req.params;
      if (!(typeof year === 'string' && /^\d{4}$/.test(year))) {
        return res.status(400).json({ error: 'Invalid year. Use YYYY.' });
      }

      // --- discovery (same pattern as your other routes) ---
      const building = await Building.findOne({
        where: { building_id },
        attributes: ['building_id','building_name','emin_con','wmin_con'],
        raw: true
      });
      if (!building) return res.status(404).json({ error: 'Building not found' });

      const stalls = await Stall.findAll({
        where: { building_id },
        attributes: ['stall_id'],
        raw: true
      });
      if (!stalls.length) return res.status(404).json({ error: 'No stalls found for this building' });

      const meters = await Meter.findAll({
        where: { stall_id: { [Op.in]: stalls.map(s => s.stall_id) } },
        attributes: ['meter_id','meter_type','meter_mult'],
        raw: true
      });
      if (!meters.length) return res.status(404).json({ error: 'No meters found for this building' });

      // --- helpers (inline for now; we can move to rocUtils later) ------------
      const ymd = d => new Date(d).toISOString().slice(0,10);
      const dt  = (y,m0,d) => new Date(Date.UTC(y, m0, d));

      // Build all 12 periods for the requested year (end on day-20, start is prev-month day-21)
      function buildYearPeriods21to20(yyyy) {
        const Y = Number(yyyy);
        const periods = [];
        for (let m = 1; m <= 12; m++) {
          const end   = dt(Y, m - 1, 20);                    // e.g., 2025-01-20 .. 2025-12-20
          const prevY = (m === 1) ? Y - 1 : Y;
          const prevM = (m === 1) ? 11   : (m - 2);          // Dec of prev year for January
          const start = dt(prevY, prevM, 21);
          periods.push({
            start: ymd(start),
            end:   ymd(end),
            month: `${yyyy}-${String(m).padStart(2,'0')}`     // label by END month (YYYY-MM)
          });
        }
        const anchorPrev = {                                  // month before January
          start: ymd(dt(Y - 1, 10, 21)),                      // Nov 21 of previous year
          end:   ymd(dt(Y - 1, 11, 20)),                      // Dec 20 of previous year
        };
        return { periods, anchorPrev };
      }

      // Latest reading in a period by lastread_date DESC
      async function getMaxReadingInPeriod(meter_id, startYMD, endYMD) {
        const row = await Reading.findOne({
          where: {
            meter_id,
            lastread_date: { [Op.gte]: startYMD, [Op.lte]: endYMD },
          },
          order: [['lastread_date', 'DESC']],
          attributes: ['reading_value', 'lastread_date'],
          raw: true
        });
        return row ? { value: Number(row.reading_value) || 0, date: row.lastread_date } : null;
      }

      function computeUnitsWithMins({ type, mult, prevIdx, currIdx }) {
        const raw = ((Number(currIdx) - Number(prevIdx)) * (Number(mult) || 1));
        const t = String(type || '').toLowerCase();
        // adjust LPG minimum if needed (0 vs 1)
        const LPG_MIN_CON = 0;
        const round = (n, p = 4) => Number.isFinite(n) ? Math.round(n * 10**p) / 10**p : 0;

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
        const err = new Error(`Unsupported meter type: ${t}`); err.status = 400; throw err;
      }

      const round2 = n => Math.round(n * 100) / 100;

      // --- build year windows + anchor, then aggregate ------------------------
      const { periods, anchorPrev } = buildYearPeriods21to20(year);

      // initialize monthly buckets
      const results = periods.map(p => ({
        month: p.month,
        start: p.start,
        end:   p.end,
        totals: { electric: 0, water: 0, lpg: 0 }
      }));

      // For each meter, fetch maxima for anchor + each month, then compute deltas
      for (const m of meters) {
        try {
          const [aMax, ...monthMaxes] = await Promise.all([
            getMaxReadingInPeriod(m.meter_id, anchorPrev.start, anchorPrev.end),
            ...periods.map(p => getMaxReadingInPeriod(m.meter_id, p.start, p.end))
          ]);

          for (let i = 0; i < periods.length; i++) {
            const prevMax = (i === 0) ? aMax : monthMaxes[i - 1];
            const currMax = monthMaxes[i];
            if (!prevMax || !currMax) continue;

            const units = computeUnitsWithMins({
              type: m.meter_type,
              mult: m.meter_mult,
              prevIdx: prevMax.value,
              currIdx: currMax.value
            });

            const key = String(m.meter_type || '').toLowerCase();
            if (key in results[i].totals) {
              results[i].totals[key] += Number(units) || 0;
            }
          }
        } catch {
          // continue on per-meter errors
        }
      }

      // finalize rounding
      results.forEach(r => {
        r.totals.electric = round2(r.totals.electric);
        r.totals.water    = round2(r.totals.water);
        r.totals.lpg      = round2(r.totals.lpg);
      });

      // respond (already Jan..Dec order)
      return res.json({
        building_id,
        building_name: building.building_name || null,
        year,
        months: results
      });
    } catch (err) {
      return sendErr(res, err, 'Yearly comparison (21→20) error');
    }
  }
);



module.exports = router;
