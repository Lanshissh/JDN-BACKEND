// routes/buildings.js
const express = require('express');
const router = express.Router();

const { Op } = require('sequelize');

// Models
const Building = require('../models/Building');

// Auth/middlewares
const authenticateToken = require('../middleware/authenticateToken');
const authorizeRole = require('../middleware/authorizeRole');
const {
  authorizeBuildingParam,
  attachBuildingScope,
  enforceRecordBuilding
} = require('../middleware/authorizeBuilding');

// Utils
const { getCurrentDateTime } = require('../utils/getCurrentDateTime');

// ---------- config / helpers ----------

// All numeric building rate fields (DECIMAL(10,2) in DB)
const NUM_FIELDS = [
  'erate_perKwH',  // electric rate / kWh
  'emin_con',      // electric min consumption
  'wrate_perCbM',  // water rate / m^3
  'wmin_con',      // water min consumption
  'lrate_perKg',   // LPG rate / kg
  'markup_rate',   // markup rate (0+)
  'penalty_rate'   // NEW: penalty rate (0+)
];

// Optional aliases accepted in payloads
const KEY_MAP = new Map([
  // electric
  ['erate_perkwh', 'erate_perKwH'],
  ['e_rate_per_kwh', 'erate_perKwH'],
  ['emin_con', 'emin_con'],
  ['e_min_con', 'emin_con'],

  // water
  ['wrate_percbm', 'wrate_perCbM'],
  ['w_rate_per_cbm', 'wrate_perCbM'],
  ['wmin_con', 'wmin_con'],
  ['w_min_con', 'wmin_con'],

  // lpg
  ['lrate_perkg', 'lrate_perKg'],
  ['l_rate_per_kg', 'lrate_perKg'],

  // markup aliases
  ['markuprate', 'markup_rate'],
  ['markup', 'markup_rate'],

  // penalty rate aliases
  ['penaltyrate', 'penalty_rate'],
  ['penalty', 'penalty_rate'],
]);

function normalizeKey(k) {
  if (!k) return k;
  const lk = String(k).trim().toLowerCase();
  return KEY_MAP.get(lk) || k;
}

function coerceRateNumbers(candidate) {
  // Ensure only known numeric fields are kept, and coerce to stringified fixed(2).
  const out = {};
  for (const f of NUM_FIELDS) {
    if (candidate[f] === undefined) continue;
    const v = candidate[f];
    if (v === null || v === '') continue;

    const num = Number(v);
    if (!Number.isFinite(num) || num < 0) {
      const msg = `Invalid value for ${f}: must be a non-negative number`;
      const err = new Error(msg);
      err.status = 400;
      throw err;
    }
    out[f] = Number(num.toFixed(2)); // keep numeric; Sequelize will handle DECIMAL
  }
  return out;
}

function pick(obj, keys) {
  const o = {};
  for (const k of keys) if (obj[k] !== undefined) o[k] = obj[k];
  return o;
}

function hasAnyRole(user, roles) {
  const r = Array.isArray(user?.user_roles) ? user.user_roles.map(x => String(x).toLowerCase()) : [];
  return roles.some(role => r.includes(String(role).toLowerCase()));
}

// ---------- routes ----------

// All building routes require a valid token
router.use(authenticateToken);

/**
 * GET /buildings
 * List buildings visible to the caller.
 * Read access: admin, operator, biller, reader
 */
router.get(
  '/',
  authorizeRole('admin', 'operator', 'biller', 'reader'),
  attachBuildingScope(),
  async (req, res) => {
    try {
      const where = req.buildingWhere ? req.buildingWhere('building_id') : {};
      const rows = await Building.findAll({
        where,
        order: [['building_id', 'ASC']]
      });
      res.json(rows);
    } catch (err) {
      console.error('GET /buildings error:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * GET /buildings/:id
 * Fetch a single building.
 * Read access: admin, operator, biller, reader
 */
router.get(
  '/:id',
  authorizeRole('admin', 'operator', 'biller', 'reader'),
  authorizeBuildingParam(),
  async (req, res) => {
    try {
      const building = await Building.findOne({ where: { building_id: req.params.id } });
      if (!building) return res.status(404).json({ message: 'Building not found' });
      res.json(building);
    } catch (err) {
      console.error('GET /buildings/:id error:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * POST /buildings
 * Create a building.
 * Write access: admin only
 * Body may include any of NUM_FIELDS, including markup_rate and penalty_rate.
 */
router.post(
  '/',
  authorizeRole('admin'),
  async (req, res) => {
    try {
      const body = req.body || {};

      // Normalize keys (aliases -> canonical)
      const canonical = {};
      for (const [k, v] of Object.entries(body)) {
        canonical[normalizeKey(k)] = v;
      }

      // Build candidate object with name + numeric fields
      const candidate = {
        building_name: canonical.building_name?.trim()
      };
      for (const f of NUM_FIELDS) {
        if (canonical[f] !== undefined) candidate[f] = canonical[f];
      }

      if (!candidate.building_name) {
        return res.status(400).json({ error: 'building_name is required' });
      }

      // Generate next building_id: BLDG-<n+1>
      const rows = await Building.findAll({
        where: { building_id: { [Op.like]: 'BLDG-%' } },
        attributes: ['building_id'],
        raw: true
      });
      const maxNum = rows.reduce((max, r) => {
        const m = String(r.building_id).match(/^BLDG-(\d+)$/);
        return m ? Math.max(max, Number(m[1])) : max;
      }, 0);
      const newId = `BLDG-${maxNum + 1}`;

      const rates = coerceRateNumbers(candidate);

      const now = getCurrentDateTime ? getCurrentDateTime() : new Date().toISOString();
      const updatedBy = req.user?.user_fullname || req.user?.user_id || 'system';

      const created = await Building.create({
        building_id: newId,
        building_name: candidate.building_name,
        ...rates,
        last_updated: now,
        updated_by: updatedBy
      });

      res.status(201).json(created);
    } catch (err) {
      const status = err.status || 500;
      console.error('POST /buildings error:', err);
      res.status(status).json({ error: err.message });
    }
  }
);

/**
 * PUT /buildings/:id
 * Update building name and/or any rates.
 * Write access: admin only (use /:id/base-rates for biller utility edits)
 */
router.put(
  '/:id',
  authorizeRole('admin'),
  authorizeBuildingParam(),
  async (req, res) => {
    try {
      const b = await Building.findOne({ where: { building_id: req.params.id } });
      if (!b) return res.status(404).json({ message: 'Building not found' });

      const body = req.body || {};
      const canonical = {};
      for (const [k, v] of Object.entries(body)) {
        canonical[normalizeKey(k)] = v;
      }

      const updates = {};
      if (canonical.building_name !== undefined) {
        const name = String(canonical.building_name || '').trim();
        if (!name) return res.status(400).json({ error: 'building_name cannot be empty' });
        updates.building_name = name;
      }

      for (const f of NUM_FIELDS) {
        if (canonical[f] !== undefined) updates[f] = canonical[f];
      }

      const rates = coerceRateNumbers(updates);

      const now = getCurrentDateTime ? getCurrentDateTime() : new Date().toISOString();
      const updatedBy = req.user?.user_fullname || req.user?.user_id || 'system';

      await b.update({
        ...('building_name' in updates ? { building_name: updates.building_name } : {}),
        ...rates,
        last_updated: now,
        updated_by: updatedBy
      });

      res.json(b);
    } catch (err) {
      const status = err.status || 500;
      console.error('PUT /buildings/:id error:', err);
      res.status(status).json({ error: err.message });
    }
  }
);

/**
 * GET /buildings/:id/base-rates
 * Read the set of base rates (includes markup_rate and penalty_rate).
 * Read access: admin, biller, reader, operator
 */
router.get(
  '/:id/base-rates',
  authorizeRole('admin', 'biller', 'operator', 'reader'),
  authorizeBuildingParam(),
  async (req, res) => {
    try {
      const building = await Building.findOne({
        where: { building_id: req.params.id },
        attributes: [
          'building_id',
          'erate_perKwH', 'emin_con',
          'wrate_perCbM', 'wmin_con',
          'lrate_perKg',
          'markup_rate',
          'penalty_rate', // NEW: include penalty_rate
          'last_updated', 'updated_by'
        ]
      });
      if (!building) return res.status(404).json({ message: 'Building not found' });
      res.json(building);
    } catch (err) {
      console.error('GET /buildings/:id/base-rates error:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * PUT /buildings/:id/base-rates
 * Update base rates.
 * - Admin: can update ALL rate fields, including markup_rate and penalty_rate.
 * - Biller: can update utility-specific fields only (no markup_rate, no penalty_rate).
 */
router.put(
  '/:id/base-rates',
  authorizeRole('admin', 'biller'),
  authorizeBuildingParam(),
  async (req, res) => {
    try {
      const building = await Building.findOne({ where: { building_id: req.params.id } });
      if (!building) return res.status(404).json({ message: 'Building not found' });

      const body = req.body || {};
      const canonical = {};
      for (const [k, v] of Object.entries(body)) {
        canonical[normalizeKey(k)] = v;
      }

      const isAdmin = hasAnyRole(req.user, ['admin']);
      const isBiller = hasAnyRole(req.user, ['biller']);

      // Determine which fields are allowed to be edited
      let allowed = [];
      if (isAdmin) {
        // Admins can edit everything
        allowed = [...NUM_FIELDS];
      } else if (isBiller) {
        // Billers: only utility rates, not markup_rate or penalty_rate
        allowed = ['erate_perKwH', 'emin_con', 'wrate_perCbM', 'wmin_con', 'lrate_perKg'];
      } else {
        return res.status(403).json({ error: 'Forbidden: role cannot edit base rates' });
      }

      // Collect only allowed fields from payload
      const candidate = pick(canonical, allowed);

      if (Object.keys(candidate).length === 0) {
        return res.status(400).json({ error: 'No editable fields provided' });
      }

      const rates = coerceRateNumbers(candidate);

      const now = getCurrentDateTime ? getCurrentDateTime() : new Date().toISOString();
      const updatedBy = req.user?.user_fullname || req.user?.user_id || 'system';

      await building.update({
        ...rates,
        last_updated: now,
        updated_by: updatedBy
      });

      // return the full base-rate view
      const refreshed = await Building.findOne({
        where: { building_id: req.params.id },
        attributes: [
          'building_id',
          'erate_perKwH', 'emin_con',
          'wrate_perCbM', 'wmin_con',
          'lrate_perKg',
          'markup_rate',
          'penalty_rate', // NEW: include penalty_rate
          'last_updated', 'updated_by'
        ]
      });

      res.json(refreshed);
    } catch (err) {
      const status = err.status || 500;
      console.error('PUT /buildings/:id/base-rates error:', err);
      res.status(status).json({ error: err.message });
    }
  }
);

module.exports = router;