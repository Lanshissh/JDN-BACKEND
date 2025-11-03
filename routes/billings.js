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
} = require('../utils/billingEngine');

// Require auth for all billing routes
router.use(authenticateToken);

/**
 * Resolve building_id for a given meter_id (for enforceRecordBuilding)
 */
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

/**
 * GET /billings/meters/:meter_id/period-end/:endDate
 * - endDate: YYYY-MM-DD
 * - optional query: ?penalty_rate=2  (percent)
 *
 * Chain:
 *  - authenticateToken (router-level)
 *  - authorizeRole('admin','operator','biller')
 *  - authorizeUtility({ roles:['operator','biller'], anyOf:['electric','water','lpg'] })
 *  - attachBuildingScope() -> sets req.restrictToBuildingIds (null for admin)
 *  - enforceRecordBuilding(resolveBuildingForMeter) -> checks record’s building
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

      res.json({
        ...result,
        generated_at: getCurrentDateTime(),
      });
    } catch (err) {
      console.error('Billing (meter) error:', err);
      res.status(err.status || 500).json({ error: err.message });
    }
  }
);

/**
 * GET /billings/tenants/:tenant_id/period-end/:endDate
 * - endDate: YYYY-MM-DD
 * - optional query: ?penalty_rate=2  (percent)
 *
 * Chain:
 *  - authenticateToken (router-level)
 *  - authorizeRole('admin','operator','biller')
 *  - attachBuildingScope() -> limits tenant’s stalls to allowed buildings (admin sees all)
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

      res.json({
        tenant_id,
        end_date: endDate,
        meters,
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
