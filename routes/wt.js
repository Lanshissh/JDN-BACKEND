// routes/wt.js
const express = require('express');
const router = express.Router();
const { Op } = require('sequelize');

const getCurrentDateTime = require('../utils/getCurrentDateTime');
const authenticateToken = require('../middleware/authenticateToken');
const authorizeRole = require('../middleware/authorizeRole');

const WT = require('../models/WT');

// All routes require login (same concept as rates.js)
router.use(authenticateToken);

/** helper: coerce numeric WT fields to DECIMAL(10,2) */
function coerceWtNumbers(obj) {
  const keys = ['e_wt', 'w_wt', 'l_wt'];
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
 *  WT CODE CATALOG (GLOBAL)
 *  =========================
 */

/** GET /wt — list WT codes (optional ?q= on code/description) */
router.get('/', authorizeRole('admin', 'biller', 'operator'), async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim();
    const where = q
      ? {
          [Op.or]: [
            { wt_code: { [Op.like]: `%${q}%` } },
            { wt_description: { [Op.like]: `%${q}%` } },
          ],
        }
      : undefined;

    const rows = await WT.findAll({ where, order: [['wt_code', 'ASC']] });
    res.json(rows);
  } catch (err) {
    console.error('GET /wt error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** GET /wt/:wt_id — fetch a WT code by primary key */
router.get('/:wt_id', authorizeRole('admin', 'biller', 'operator'), async (req, res) => {
  try {
    const row = await WT.findByPk(req.params.wt_id);
    if (!row) return res.status(404).json({ error: 'WT record not found' });
    res.json(row);
  } catch (err) {
    console.error('GET /wt/:wt_id error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** POST /wt — create a WT code (admin & biller) */
router.post('/', authorizeRole('admin', 'biller'), async (req, res) => {
  try {
    const { wt_code, wt_description, e_wt, w_wt, l_wt } = req.body || {};
    if (!wt_code) {
      return res.status(400).json({ error: 'wt_code is required' });
    }

    // coerce numbers (percent points)
    const coerced = coerceWtNumbers({ e_wt, w_wt, l_wt });
    if (!coerced.ok) return res.status(400).json({ error: coerced.error });

    // Generate next WT-<n> (cross-dialect; MSSQL-safe)
    const rows = await WT.findAll({
      where: { wt_id: { [Op.like]: 'WT-%' } },
      attributes: ['wt_id'],
      raw: true
    });
    const maxNum = rows.reduce((max, r) => {
      const m = String(r.wt_id).match(/^WT-(\d+)$/);
      return m ? Math.max(max, Number(m[1])) : max;
    }, 0);
    const newWtId = `WT-${maxNum + 1}`;

    const now = getCurrentDateTime();
    const updatedBy = req.user?.user_fullname || 'System Admin';

    const created = await WT.create({
      wt_id: newWtId,
      wt_code,
      wt_description: wt_description ?? 'Insert Description',
      ...coerced.data,
      last_updated: now,
      updated_by: updatedBy,
    });

    res.status(201).json(created);
  } catch (err) {
    if (String(err?.name) === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ error: 'wt_code must be unique' });
    }
    console.error('POST /wt error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});


/** PUT /wt/:wt_id — update a WT code (admin & biller) */
router.put('/:wt_id', authorizeRole('admin', 'biller'), async (req, res) => {
  try {
    const row = await WT.findByPk(req.params.wt_id);
    if (!row) return res.status(404).json({ error: 'WT record not found' });

    const candidate = {
      wt_code: req.body?.wt_code,
      wt_description: req.body?.wt_description,
      e_wt: req.body?.e_wt,
      w_wt: req.body?.w_wt,
      l_wt: req.body?.l_wt,
    };

    const coerced = coerceWtNumbers(candidate);
    if (!coerced.ok) return res.status(400).json({ error: coerced.error });

    const now = getCurrentDateTime();
    const updatedBy = req.user?.user_fullname || 'System Admin';

    await row.update({
      ...coerced.data,
      wt_code: candidate.wt_code ?? row.wt_code,
      wt_description: candidate.wt_description ?? row.wt_description,
      last_updated: now,
      updated_by: updatedBy,
    });

    res.json(row);
  } catch (err) {
    if (String(err?.name) === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ error: 'wt_code must be unique' });
    }
    console.error('PUT /wt/:wt_id error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/** DELETE /wt/:wt_id — delete a WT code (admin & biller) */
router.delete('/:wt_id', authorizeRole('admin', 'biller'), async (req, res) => {
  try {
    const deleted = await WT.destroy({ where: { wt_id: req.params.wt_id } });
    if (deleted === 0) return res.status(404).json({ error: 'WT record not found' });
    res.json({ message: 'WT record deleted' });
  } catch (err) {
    console.error('DELETE /wt/:wt_id error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
