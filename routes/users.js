const express = require('express');
const router = express.Router();

// Utilities & middleware
const { hashPassword } = require('../utils/hashPassword');
const authenticateToken = require('../middleware/authenticateToken');
const authorizeRole = require('../middleware/authorizeRole');

// Sequelize
const { Op } = require('sequelize');

// Models
const User = require('../models/User');

// All routes below require a valid token
router.use(authenticateToken);

// ---- helpers ----
const ALLOWED_ROLES = new Set(['admin', 'operator', 'biller', 'reader']);

function normalizeArray(v) {
  if (Array.isArray(v)) return v;
  if (v == null) return [];
  if (typeof v === 'string') {
    // Try JSON first, then fallback to comma-separated
    try { const parsed = JSON.parse(v); if (Array.isArray(parsed)) return parsed; } catch {}
    return v.split(',').map(s => s.trim()).filter(Boolean);
  }
  return [v];
}

/**
 * Enforce that when 'admin' is present, it must be the ONLY role.
 * Returns { ok: true, roles: [...] } on success,
 * or { ok: false, error: '...' } on policy violation.
 */
function enforceAdminExclusivity(inputRoles) {
  const roles = normalizeArray(inputRoles)
    .map(x => String(x).toLowerCase())
    .filter(x => ALLOWED_ROLES.has(x));

  if (roles.includes('admin')) {
    // admin must be the ONLY role
    if (roles.length > 1) {
      return { ok: false, error: "When assigning 'admin', it must be the only role (no multi-role allowed for admin)." };
    }
    return { ok: true, roles: ['admin'] };
  }
  // non-admin roles can be multiple (dedupe)
  const deduped = Array.from(new Set(roles));
  return { ok: true, roles: deduped };
}

// ---- routes ----

/** GET all users (admin) */
router.get('/', authorizeRole('admin'), async (_req, res) => {
  try {
    const users = await User.findAll();
    // Keep response tidy: ensure arrays are arrays
    res.json(users.map(u => ({
      user_id: u.user_id,
      user_fullname: u.user_fullname,
      user_roles: Array.isArray(u.user_roles) ? u.user_roles : [],
      building_ids: Array.isArray(u.building_ids) ? u.building_ids : [],
      utility_role: Array.isArray(u.utility_role) ? u.utility_role : [],
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** CREATE user (admin) */
router.post('/', authorizeRole('admin'), async (req, res) => {
  try {
    const {
      user_password,
      user_fullname,
      user_roles: rolesIn,
      building_ids: buildingsIn,
      utility_role: utilitiesIn
    } = req.body || {};

    if (!user_password || !user_fullname) {
      return res.status(400).json({ error: 'user_password and user_fullname are required' });
    }

    // Enforce admin exclusivity rule
    const roleCheck = enforceAdminExclusivity(rolesIn);
    if (!roleCheck.ok) return res.status(400).json({ error: roleCheck.error });
    const user_roles = roleCheck.roles;

    const building_ids = normalizeArray(buildingsIn).map(String);
    const utility_role = normalizeArray(utilitiesIn).map(String);

    // Build next USER-<n> (MSSQL safe)
    const rows = await User.findAll({
      where: { user_id: { [Op.like]: 'USER-%' } },
      attributes: ['user_id'],
      raw: true
    });
    const maxNum = rows.reduce((max, r) => {
      const m = String(r.user_id).match(/^USER-(\d+)$/);
      return m ? Math.max(max, Number(m[1])) : max;
    }, 0);
    const newUserId = `USER-${maxNum + 1}`;

    const hashed = await hashPassword(user_password);

    const created = await User.create({
      user_id: newUserId,
      user_password: hashed,
      user_fullname,
      user_roles,
      building_ids,
      utility_role
    });

    res.status(201).json({
      user_id: created.user_id,
      user_fullname: created.user_fullname,
      user_roles: created.user_roles,
      building_ids: created.building_ids,
      utility_role: created.utility_role
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** UPDATE user (admin) */
router.put('/:user_id', authorizeRole('admin'), async (req, res) => {
  try {
    const user = await User.findByPk(req.params.user_id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const {
      user_password,
      user_fullname,
      user_roles: rolesIn,
      building_ids: buildingsIn,
      utility_role: utilitiesIn
    } = req.body || {};

    if (user_fullname !== undefined) user.user_fullname = user_fullname;
    if (user_password) user.user_password = await hashPassword(user_password);

    if (rolesIn !== undefined) {
      // Enforce admin exclusivity rule on update too
      const roleCheck = enforceAdminExclusivity(rolesIn);
      if (!roleCheck.ok) return res.status(400).json({ error: roleCheck.error });
      user.user_roles = roleCheck.roles;
    }

    if (buildingsIn !== undefined) {
      user.building_ids = normalizeArray(buildingsIn).map(String);
    }

    if (utilitiesIn !== undefined) {
      user.utility_role = normalizeArray(utilitiesIn).map(String);
    }

    await user.save();

    res.json({
      user_id: user.user_id,
      user_fullname: user.user_fullname,
      user_roles: user.user_roles,
      building_ids: user.building_ids,
      utility_role: user.utility_role
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** DELETE user (admin) */
router.delete('/:user_id', authorizeRole('admin'), async (req, res) => {
  try {
    const user = await User.findByPk(req.params.user_id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    await user.destroy();
    res.json({ message: 'User deleted' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
