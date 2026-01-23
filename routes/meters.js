const express = require('express');
const router = express.Router();

const getCurrentDateTime = require('../utils/getCurrentDateTime');
const authenticateToken = require('../middleware/authenticateToken');
const authorizeRole = require('../middleware/authorizeRole');
const authorizeAccess = require('../middleware/authorizeAccess');
const {
  // authorizeBuildingParam,  // ❌ REMOVE from POST /meters (was causing "No building specified...")
  attachBuildingScope,
  enforceRecordBuilding
} = require('../middleware/authorizeBuilding');

const { Op } = require('sequelize');

const Meter = require('../models/Meter');
const Stall = require('../models/Stall');
const Reading = require('../models/Reading');
const Tenant = require('../models/Tenant');

// All routes require a valid token
router.use(authenticateToken);

const ALLOWED_TYPES = new Set(['electric', 'water', 'lpg']);
const ALLOWED_STATUS = new Set(['active', 'inactive']);

/** Helpers to support both OLD tokens and NEW tokens (user_roles/building_ids) */
function getUserRoles(req) {
  const roles = req.user?.user_roles;
  if (Array.isArray(roles)) return roles.map(r => String(r).toLowerCase());
  // fallback older style
  if (req.user?.user_level) return [String(req.user.user_level).toLowerCase()];
  return [];
}

function isAdminUser(req) {
  const roles = getUserRoles(req);
  return roles.includes('admin');
}

function getAllowedBuildingIds(req) {
  // NEW style: building_ids array
  const ids = req.user?.building_ids;
  if (Array.isArray(ids) && ids.length) return ids.map(String);

  // fallback OLD style: single building_id
  if (req.user?.building_id) return [String(req.user.building_id)];

  return [];
}

/**
 * GET /meters
 * - admin: all
 * - operator: only meters in their building (via Stall.building_id)
 * Now also returns:
 *   - tenant_id
 *   - tenant_name
 *   - tenant_sn (if present on Tenant)
 */
router.get('/',
  authorizeAccess('meters'),
  authorizeRole('admin', 'operator', 'biller', 'reader'),
  attachBuildingScope(),
  async (req, res) => {
    try {
      let meters = [];
      let stallRows = [];

      // ADMIN: no building restriction
      if (!req.restrictToBuildingId) {
        meters = await Meter.findAll({ raw: true });
        if (!meters.length) {
          return res.json([]);
        }

        const stallIds = [...new Set(
          meters.map(m => m.stall_id).filter(Boolean)
        )];

        if (stallIds.length) {
          stallRows = await Stall.findAll({
            where: { stall_id: stallIds },
            attributes: ['stall_id', 'tenant_id'],
            raw: true
          });
        }
      } else {
        // OPERATOR: restricted to a single building
        stallRows = await Stall.findAll({
          where: { building_id: req.restrictToBuildingId },
          attributes: ['stall_id', 'tenant_id'],
          raw: true
        });

        const stallIds = [...new Set(
          stallRows.map(s => s.stall_id).filter(Boolean)
        )];

        if (!stallIds.length) {
          return res.json([]);
        }

        meters = await Meter.findAll({
          where: { stall_id: stallIds },
          raw: true
        });

        if (!meters.length) {
          return res.json([]);
        }
      }

      if (!stallRows.length) {
        const resultNoStall = meters.map(m => ({
          ...m,
          tenant_id: null,
          tenant_name: null,
          tenant_sn: null
        }));
        return res.json(resultNoStall);
      }

      const stallToTenant = new Map(
        stallRows.map(s => [s.stall_id, s.tenant_id])
      );

      const tenantIds = [...new Set(
        stallRows.map(s => s.tenant_id).filter(Boolean)
      )];

      let tenantMap = new Map();
      if (tenantIds.length) {
        const tenants = await Tenant.findAll({
          where: { tenant_id: tenantIds },
          attributes: ['tenant_id', 'tenant_name', 'tenant_sn'],
          raw: true
        });

        tenantMap = new Map(
          tenants.map(t => [t.tenant_id, t])
        );
      }

      const result = meters.map(m => {
        const tenantId = stallToTenant.get(m.stall_id) || null;
        const tenant = tenantId ? tenantMap.get(tenantId) : null;

        return {
          ...m,
          tenant_id: tenantId,
          tenant_name: tenant?.tenant_name || null,
          tenant_sn: tenant?.tenant_sn || null
        };
      });

      return res.json(result);
    } catch (err) {
      console.error('Database error:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * GET /meters/:id
 * - admin: full access
 * - operator: only if the meter’s stall belongs to their building
 */
router.get('/:id',
  authorizeAccess('meters'),
  authorizeRole('admin', 'operator'),
  enforceRecordBuilding(async (req) => {
    const meter = await Meter.findOne({
      where: { meter_id: req.params.id },
      attributes: ['stall_id'],
      raw: true
    });
    if (!meter) return null;

    const stall = await Stall.findOne({
      where: { stall_id: meter.stall_id },
      attributes: ['building_id'],
      raw: true
    });
    return stall?.building_id || null;
  }),
  async (req, res) => {
    try {
      const meter = await Meter.findOne({ where: { meter_id: req.params.id } });
      if (!meter) return res.status(404).json({ message: 'Meter not found' });
      res.json(meter);
    } catch (err) {
      console.error('Database error:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * POST /meters
 * - admin: any building
 * - operator: only inside their allowed buildings (checks stall.building_id)
 * - defaults meter_mult: water -> 93.00, others -> 1 (if not provided)
 *
 * ✅ IMPORTANT CHANGE:
 * - removed authorizeBuildingParam() so UI does NOT need to send building_id
 *   (stall selection already determines building and access is validated)
 */
router.post('/',
  authorizeAccess('meters'),
  authorizeRole('admin', 'operator'),
  async (req, res) => {
    let { meter_type, meter_sn, meter_mult, stall_id, meter_status } = req.body || {};

    if (!meter_type || !meter_sn || !stall_id || !meter_status) {
      return res.status(400).json({ error: 'meter_type, meter_sn, stall_id, and meter_status are required' });
    }
    meter_type = String(meter_type).toLowerCase();
    meter_status = String(meter_status).toLowerCase();
    if (!ALLOWED_TYPES.has(meter_type)) {
      return res.status(400).json({ error: 'meter_type must be one of: electric, water, lpg' });
    }
    if (!ALLOWED_STATUS.has(meter_status)) {
      return res.status(400).json({ error: 'meter_status must be one of: active, inactive' });
    }

    try {
      const dup = await Meter.findOne({ where: { meter_sn } });
      if (dup) return res.status(409).json({ error: 'meter_sn already exists' });

      const stall = await Stall.findOne({
        where: { stall_id },
        attributes: ['building_id'],
        raw: true
      });
      if (!stall) return res.status(400).json({ error: 'Invalid stall_id: Stall does not exist.' });

      const isAdmin = isAdminUser(req);
      if (!isAdmin) {
        const allowedBuildings = getAllowedBuildingIds(req);
        if (!allowedBuildings.length) {
          return res.status(403).json({ error: 'No building assigned to your account.' });
        }
        if (!allowedBuildings.includes(String(stall.building_id))) {
          return res.status(403).json({ error: 'No access: Stall not under your assigned building.' });
        }
      }

      const rows = await Meter.findAll({
        where: { meter_id: { [Op.like]: 'MTR-%' } },
        attributes: ['meter_id'],
        raw: true
      });
      const maxNum = rows.reduce((max, r) => {
        const m = String(r.meter_id).match(/^MTR-(\d+)$/);
        return m ? Math.max(max, Number(m[1])) : max;
      }, 0);
      const newMeterId = `MTR-${maxNum + 1}`;

      if (meter_mult === undefined || meter_mult === null || meter_mult === '') {
        meter_mult = (meter_type === 'water') ? 93.00 : 1;
      } else {
        const asNum = Number(meter_mult);
        if (!Number.isFinite(asNum)) {
          return res.status(400).json({ error: 'meter_mult must be a valid number' });
        }
        meter_mult = Math.round(asNum * 100) / 100;
      }

      await Meter.create({
        meter_id: newMeterId,
        meter_type,
        meter_sn,
        meter_mult,
        stall_id,
        meter_status,
        last_updated: getCurrentDateTime(),
        updated_by: req.user?.user_fullname || 'system'
      });

      res.status(201).json({ message: 'Meter created successfully', meterId: newMeterId });
    } catch (err) {
      console.error('Error in POST /meters:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * PUT /meters/:id
 * - admin: unrestricted
 * - operator: only if meter is under their building; if moving to a new stall, that stall must also be under their building
 * - if meter_type changes and meter_mult not provided, assign default (water->93 else 1)
 */
router.put(
  '/:id',
  authorizeAccess('meters'),
  authorizeRole('admin', 'operator'),
  attachBuildingScope(),
  enforceRecordBuilding(async (req) => {
    const m = await Meter.findOne({
      where: { meter_id: req.params.id },
      attributes: ['meter_id', 'stall_id'],
      raw: true
    });
    if (!m) return null;

    const s = await Stall.findOne({
      where: { stall_id: m.stall_id },
      attributes: ['building_id'],
      raw: true
    });
    return s?.building_id;
  }),
  async (req, res) => {
    const meterId = req.params.id;
    let { meter_type, meter_sn, stall_id, meter_status, meter_mult } = req.body || {};

    try {
      const meter = await Meter.findOne({ where: { meter_id: meterId } });
      if (!meter) return res.status(404).json({ error: 'Meter not found' });

      if (stall_id && stall_id !== meter.stall_id) {
        const target = await Stall.findOne({
          where: { stall_id },
          attributes: ['stall_id', 'building_id'],
          raw: true
        });
        if (!target) {
          return res.status(400).json({ error: 'Invalid stall_id: Stall does not exist.' });
        }

        if (!isAdminUser(req)) {
          const allowed = getAllowedBuildingIds(req);
          if (!allowed.includes(String(target.building_id))) {
            return res.status(403).json({ error: 'No access: Target stall not under your building(s).' });
          }
        }
      }

      if (meter_sn && meter_sn !== meter.meter_sn) {
        const exists = await Meter.findOne({
          where: { meter_sn, meter_id: { [Op.ne]: meterId } },
          attributes: ['meter_id'],
          raw: true
        });
        if (exists) return res.status(409).json({ error: 'meter_sn already exists' });
      }

      if (meter_type !== undefined) {
        meter_type = String(meter_type).toLowerCase();
        if (!ALLOWED_TYPES.has(meter_type)) {
          return res.status(400).json({ error: 'meter_type must be one of: electric, water, lpg' });
        }
      }
      if (meter_status !== undefined) {
        meter_status = String(meter_status).toLowerCase();
        if (!ALLOWED_STATUS.has(meter_status)) {
          return res.status(400).json({ error: 'meter_status must be one of: active, inactive' });
        }
      }

      let finalMult = (meter_mult !== undefined) ? meter_mult : meter.meter_mult;
      if (meter_mult !== undefined) {
        const asNum = Number(meter_mult);
        if (!Number.isFinite(asNum)) {
          return res.status(400).json({ error: 'meter_mult must be a valid number' });
        }
        finalMult = Math.round(asNum * 100) / 100;
      } else if (meter_type && meter_type !== meter.meter_type) {
        finalMult = (meter_type === 'water') ? 93.00 : 1;
      }

      await meter.update({
        meter_type: meter_type ?? meter.meter_type,
        meter_sn: meter_sn ?? meter.meter_sn,
        stall_id: stall_id ?? meter.stall_id,
        meter_status: meter_status ?? meter.meter_status,
        meter_mult: finalMult,
        last_updated: getCurrentDateTime(),
        updated_by: req.user?.user_fullname || 'system'
      });

      res.json({ message: `Meter with ID ${meterId} updated successfully` });
    } catch (err) {
      console.error('Error in PUT /meters/:id:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * DELETE /meters/:id
 * - admin: unrestricted
 * - operator: only if meter is under their building
 * - blocks delete if readings exist
 */
router.delete('/:id',
  authorizeAccess('meters'),
  authorizeRole('admin', 'operator'),
  async (req, res) => {
    const meterId = req.params.id;
    if (!meterId) return res.status(400).json({ error: 'Meter ID is required' });

    try {
      if (!isAdminUser(req)) {
        const meter = await Meter.findOne({
          where: { meter_id: meterId },
          attributes: ['stall_id'],
          raw: true
        });
        if (!meter) return res.status(404).json({ error: 'Meter not found' });

        const stall = await Stall.findOne({
          where: { stall_id: meter.stall_id },
          attributes: ['building_id'],
          raw: true
        });

        const allowedBuildings = getAllowedBuildingIds(req);
        if (!stall || !allowedBuildings.includes(String(stall.building_id))) {
          return res.status(403).json({ error: 'No access: Meter not under your assigned building.' });
        }
      }

      const readings = await Reading.findAll({
        where: { meter_id: meterId },
        attributes: ['reading_id']
      });

      if (readings.length) {
        return res.status(400).json({
          error: `Cannot delete meter. It is still referenced by: Reading(s) [${readings.map(r => r.reading_id).join(', ')}]`
        });
      }

      const deleted = await Meter.destroy({ where: { meter_id: meterId } });
      if (deleted === 0) return res.status(404).json({ error: 'Meter not found' });

      res.json({ message: `Meter with ID ${meterId} deleted successfully` });
    } catch (err) {
      console.error('Error in DELETE /meters/:id:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;