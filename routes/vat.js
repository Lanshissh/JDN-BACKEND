const express = require('express');
const router = express.Router();
const { Op } = require('sequelize');

const getCurrentDateTime = require('../utils/getCurrentDateTime');
const authenticateToken = require('../middleware/authenticateToken');
const authorizeRole = require('../middleware/authorizeRole');
const { authorizeBuildingParam } = require('../middleware/authorizeBuilding');

const Tenant = require('../models/Tenant');
const VAT = require('../models/VAT');

// All routes require login (same concept as rates.js)
router.use(authenticateToken);

/** helper: coerce numeric VAT fields to DECIMAL(10,2) percent points */
function coerceVatNumbers(obj) {
  const keys = ['e_vat', 'w_vat', 'l_vat'];
  const out = { ...obj };
  for (const k of keys) {
    if (out[k] !== undefined) {
      const n = Number(out[k]);
      if (!Number.isFinite(n) || n < 0) {
        return { ok: false, error: `${k} must be a non-negative number` };
      }
      // round to 2 decimals (e.g., 12.00 for 12%)
      out[k] = Math.round(n * 100) / 100;
    }
  }
  return { ok: true, data: out };
}

/** =========================
 *  VAT CODE CATALOG (GLOBAL)
 *  =========================
 */

/** GET /vat — list VAT codes (optional ?q= on code/description) */
router.get('/', authorizeRole('admin', 'biller', 'operator'), async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim();
    const where = q
      ? {
          [Op.or]: [
            { vat_code: { [Op.like]: `%${q}%` } },
            { vat_description: { [Op.like]: `%${q}%` } },
          ],
        }
      : undefined;

    const rows = await VAT.findAll({ where, order: [['vat_code', 'ASC']] });
    res.json(rows);
  } catch (err) {
    console.error('GET /vat error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** GET /vat/:tax_id — fetch a VAT code by primary key */
router.get('/:tax_id', authorizeRole('admin', 'biller', 'operator'), async (req, res) => {
  try {
    const row = await VAT.findByPk(req.params.tax_id);
    if (!row) return res.status(404).json({ error: 'VAT record not found' });
    res.json(row);
  } catch (err) {
    console.error('GET /vat/:tax_id error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** POST /vat — create a VAT code (admin & biller) */
router.post('/', authorizeRole('admin', 'biller'), async (req, res) => {
  try {
    const { vat_code, vat_description, e_vat, w_vat, l_vat } = req.body || {};
    if (!vat_code) {
      return res.status(400).json({ error: 'vat_code is required' });
    }

    // coerce numbers (percent points)
    const coerced = coerceVatNumbers({ e_vat, w_vat, l_vat });
    if (!coerced.ok) return res.status(400).json({ error: coerced.error });

    // Generate next VAT-<n> (cross-dialect; MSSQL-safe)
    const rows = await VAT.findAll({
      where: { tax_id: { [Op.like]: 'VAT-%' } },
      attributes: ['tax_id'],
      raw: true
    });
    const maxNum = rows.reduce((max, r) => {
      const m = String(r.tax_id).match(/^VAT-(\d+)$/);
      return m ? Math.max(max, Number(m[1])) : max;
    }, 0);
    const newTaxId = `VAT-${maxNum + 1}`;

    const now = getCurrentDateTime();
    const updatedBy = req.user?.user_fullname || 'System Admin';

    const created = await VAT.create({
      tax_id: newTaxId,
      vat_code,
      vat_description: vat_description ?? 'Zero Rated',
      ...coerced.data,
      last_updated: now,
      updated_by: updatedBy,
    });

    res.status(201).json(created);
  } catch (err) {
    if (String(err?.name) === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ error: 'vat_code must be unique' });
    }
    console.error('POST /vat error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});


/** PUT /vat/:tax_id — update a VAT code (admin & biller) */
router.put('/:tax_id', authorizeRole('admin', 'biller'), async (req, res) => {
  try {
    const row = await VAT.findByPk(req.params.tax_id);
    if (!row) return res.status(404).json({ error: 'VAT record not found' });

    const candidate = {
      vat_code: req.body?.vat_code,
      vat_description: req.body?.vat_description,
      e_vat: req.body?.e_vat,
      w_vat: req.body?.w_vat,
      l_vat: req.body?.l_vat,
    };

    const coerced = coerceVatNumbers(candidate);
    if (!coerced.ok) return res.status(400).json({ error: coerced.error });

    const now = getCurrentDateTime();
    const updatedBy = req.user?.user_fullname || 'System Admin';

    await row.update({
      ...coerced.data,
      vat_code: candidate.vat_code ?? row.vat_code,
      vat_description: candidate.vat_description ?? row.vat_description,
      last_updated: now,
      updated_by: updatedBy,
    });

    res.json(row);
  } catch (err) {
    if (String(err?.name) === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ error: 'vat_code must be unique' });
    }
    console.error('PUT /vat/:tax_id error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** DELETE /vat/:tax_id — delete a VAT code (admin & biller) */
router.delete('/:tax_id', authorizeRole('admin', 'biller'), async (req, res) => {
  try {
    const deleted = await VAT.destroy({ where: { tax_id: req.params.tax_id } });
    if (deleted === 0) return res.status(404).json({ error: 'VAT record not found' });
    res.json({ message: 'VAT record deleted' });
  } catch (err) {
    console.error('DELETE /vat/:tax_id error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** ===================================================
 *  REPORTING: TENANTS BY BUILDING WITH THEIR VAT CODE
 *  (Biller sees only their assigned building via middleware)
 *  ===================================================
 */
router.get(
  '/buildings/:building_id/tenants',
  authorizeRole('admin', 'biller', 'operator'),
  authorizeBuildingParam(), // non-admin must match :building_id
  async (req, res) => {
    try {
      const tenants = await Tenant.findAll({
        where: { building_id: req.params.building_id },
        attributes: ['tenant_id', 'tenant_name', 'vat_code'],
        include: [
          {
            model: VAT,
            as: 'vat',
            attributes: ['vat_code', 'vat_description', 'e_vat', 'w_vat', 'l_vat'],
            required: false, // show tenants even if vat_code is null or missing
          },
        ],
        order: [['tenant_name', 'ASC']],
      });

      res.json(tenants);
    } catch (err) {
      console.error('GET /vat/buildings/:building_id/tenants error:', err);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

module.exports = router;
