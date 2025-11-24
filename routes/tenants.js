// routes/tenants.js
const express = require('express');
const router = express.Router();

// Utilities & middleware
const getCurrentDateTime = require('../utils/getCurrentDateTime');
const authenticateToken = require('../middleware/authenticateToken');
const authorizeRole = require('../middleware/authorizeRole');
const {
  authorizeBuildingParam,
  attachBuildingScope,
  enforceRecordBuilding
} = require('../middleware/authorizeBuilding');

// Sequelize
const { Op } = require('sequelize');

// Models
const sequelize = require('../models');           // your initialized sequelize instance
const Tenant = require('../models/Tenant');
const Building = require('../models/Building');   // only used for existence checks (optional)

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Generates the next tenant_id in the form: TNT-<n>
 * If you want zero-padding (e.g., TNT-0001), just replace the return with padStart.
 */
async function generateNextTenantId(t) {
  // Lock the table range we care about to avoid race conditions (dialect permitting)
  const rows = await Tenant.findAll({
    attributes: ['tenant_id'],
    where: { tenant_id: { [Op.like]: 'TNT-%' } },
    transaction: t,
    lock: t?.LOCK && t.LOCK.UPDATE, // works on postgres/mysql/mssql
    raw: true,
  });

  let maxNum = 0;
  for (const r of rows) {
    const m = String(r.tenant_id).match(/^TNT-(\d+)$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (!Number.isNaN(n) && n > maxNum) maxNum = n;
    }
  }
  // Return next value
  // To enable zero-padding: return `TNT-${String(maxNum + 1).padStart(4, '0')}`;
  return `TNT-${maxNum + 1}`;
}

/** Coerce boolean-ish payloads (e.g., 'true'/'false') */
function toBool(v, fallback = false) {
  if (typeof v === 'boolean') return v;
  if (v === null || v === undefined) return fallback;
  const s = String(v).trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(s)) return true;
  if (['false', '0', 'no', 'n'].includes(s)) return false;
  return fallback;
}

// -----------------------------------------------------------------------------
// Routes
// -----------------------------------------------------------------------------

/**
 * GET /tenants
 * - admin: can see all (optionally filter by ?building_id=...)
 * - operator/biller: scoped to their building_ids from JWT
 * Supports query params:
 *   q           - search in tenant_sn, tenant_name, tenant_id
 *   status      - exact match (e.g., active/inactive)
 *   building_id - admin only (overrides scope if provided)
 */
router.get(
  '/',
  authenticateToken,
  authorizeRole('admin', 'operator', 'biller'),
  async (req, res) => {
    try {
      const { q, status, building_id } = req.query || {};

      // Roles now come from user_roles array in the JWT
      const rawRoles = Array.isArray(req.user?.user_roles)
        ? req.user.user_roles
        : [];
      const roles = rawRoles.map((r) => String(r).toLowerCase());
      const isAdmin = roles.includes('admin');

      const where = {};

      if (isAdmin) {
        // Admin: optional explicit building filter via query
        if (building_id) {
          where.building_id = String(building_id);
        }
      } else {
        // Operator / biller: restrict to building_ids from JWT
        const bIds = Array.isArray(req.user?.building_ids)
          ? req.user.building_ids.map((id) => String(id))
          : [];

        if (!bIds.length) {
          return res
            .status(401)
            .json({ error: 'Unauthorized: No building assigned to this user.' });
        }

        where.building_id =
          bIds.length === 1 ? bIds[0] : { [Op.in]: bIds };
      }

      if (status) {
        where.tenant_status = status;
      }

      if (q) {
        where[Op.or] = [
          { tenant_sn:   { [Op.like]: `%${q}%` } },
          { tenant_name: { [Op.like]: `%${q}%` } },
          { tenant_id:   { [Op.like]: `%${q}%` } },
        ];
      }

      const tenants = await Tenant.findAll({
        where,
        order: [['tenant_name', 'ASC']],
      });

      res.json(tenants);
    } catch (err) {
      console.error('Error in GET /tenants:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * GET /tenants/:id
 * - admin: full access
 * - operator/biller: only if tenant.building_id === req.user.building_id
 */
router.get(
  '/:id',
  authenticateToken,
  authorizeRole('admin', 'operator', 'biller'),
  enforceRecordBuilding(async (req) => {
    const rec = await Tenant.findOne({ where: { tenant_id: req.params.id } });
    return rec?.building_id;
  }),
  async (req, res) => {
    try {
      const tenant = await Tenant.findOne({ where: { tenant_id: req.params.id } });
      if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
      res.json(tenant);
    } catch (err) {
      console.error('Error in GET /tenants/:id:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * POST /tenants
 * Creates a tenant with auto-generated tenant_id as TNT-<n>.
 * - admin, biller can create (adjust roles as you need)
 * Body:
 *   tenant_sn, tenant_name, building_id, tenant_status, vat_code, wt_code, for_penalty
 */
router.post(
  '/',
  authenticateToken,
  authorizeRole('admin', 'biller'),
  authorizeBuildingParam('body', 'building_id'), // non-admin must match their building
  async (req, res) => {
    const {
      tenant_sn,
      tenant_name,
      building_id,
      tenant_status = 'active',
      vat_code = null,
      wt_code = null,
      for_penalty = false,
    } = req.body || {};

    if (!tenant_name) {
      return res.status(400).json({ error: 'tenant_name is required' });
    }
    if (!building_id) {
      return res.status(400).json({ error: 'building_id is required' });
    }

    try {
      // Optional: verify building exists
      const b = await Building.findOne({ where: { building_id } });
      if (!b) return res.status(404).json({ error: 'Building not found' });

      const result = await sequelize.transaction(async (t) => {
        const newTenantId = await generateNextTenantId(t);

        const created = await Tenant.create(
          {
            tenant_id: newTenantId,                // <-- TNT-#
            tenant_sn: tenant_sn || null,
            tenant_name,
            building_id,
            tenant_status,
            vat_code,
            wt_code,
            for_penalty: toBool(for_penalty, false),
            last_updated: getCurrentDateTime(),
            updated_by: req.user?.user_fullname || 'System Admin',
          },
          { transaction: t }
        );

        return created;
      });

      res.status(201).json({
        message: 'Tenant created successfully',
        tenant: result,
      });
    } catch (err) {
      console.error('Error in POST /tenants:', err);
      if (err?.name === 'SequelizeUniqueConstraintError') {
        return res.status(409).json({ error: 'Duplicate tenant_sn or tenant_id' });
      }
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * PUT /tenants/:id
 * - admin: full access
 * - operator/biller: only within their building
 * (Does not change tenant_id)
 */
router.put(
  '/:id',
  authenticateToken,
  authorizeRole('admin', 'operator', 'biller'),
  enforceRecordBuilding(async (req) => {
    const rec = await Tenant.findOne({ where: { tenant_id: req.params.id } });
    return rec?.building_id;
  }),
  async (req, res) => {
    try {
      const {
        tenant_sn,
        tenant_name,
        tenant_status,
        vat_code,
        wt_code,
        for_penalty,
      } = req.body || {};

      const tenant = await Tenant.findOne({ where: { tenant_id: req.params.id } });
      if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

      // If client tries to move tenant to another building, require admin + param guard
      if (req.body?.building_id && req.body.building_id !== tenant.building_id) {
        if ((req.user?.user_level || '').toLowerCase() !== 'admin') {
          return res.status(403).json({ error: 'Changing building_id requires admin' });
        }
        // (Optional) verify new building exists
        const b = await Building.findOne({ where: { building_id: req.body.building_id } });
        if (!b) return res.status(404).json({ error: 'New building_id not found' });
      }

      await tenant.update({
        tenant_sn: tenant_sn ?? tenant.tenant_sn,
        tenant_name: tenant_name ?? tenant.tenant_name,
        tenant_status: tenant_status ?? tenant.tenant_status,
        vat_code: vat_code ?? tenant.vat_code,
        wt_code: wt_code ?? tenant.wt_code,
        for_penalty: typeof for_penalty === 'undefined' ? tenant.for_penalty : toBool(for_penalty, tenant.for_penalty),
        building_id: req.body?.building_id ?? tenant.building_id,
        last_updated: getCurrentDateTime(),
        updated_by: req.user?.user_fullname || 'System Admin',
      });

      res.json({ message: 'Tenant updated successfully', tenant });
    } catch (err) {
      console.error('Error in PUT /tenants/:id:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * DELETE /tenants/:id
 * - admin: full access
 * - operator/biller: only if in their building
 */
router.delete(
  '/:id',
  authenticateToken,
  authorizeRole('admin', 'operator', 'biller'),
  enforceRecordBuilding(async (req) => {
    const rec = await Tenant.findOne({ where: { tenant_id: req.params.id } });
    return rec?.building_id;
  }),
  async (req, res) => {
    try {
      const deleted = await Tenant.destroy({ where: { tenant_id: req.params.id } });
      if (deleted === 0) return res.status(404).json({ error: 'Tenant not found' });
      res.json({ message: `Tenant ${req.params.id} deleted successfully` });
    } catch (err) {
      console.error('Error in DELETE /tenants/:id:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;
