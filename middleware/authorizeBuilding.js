// middleware/authorizeBuilding.js
'use strict';

const { Op } = require('sequelize');

/**
 * Admin detection:
 * - NEW: user_roles array contains 'admin'
 * - OLD: user_level === 'admin'
 */
function isAdmin(user) {
  const roles = Array.isArray(user?.user_roles)
    ? user.user_roles.map(r => String(r).toLowerCase())
    : [];

  if (roles.includes('admin')) return true;

  const level = String(user?.user_level || '').toLowerCase();
  return level === 'admin';
}

/**
 * Building IDs:
 * - NEW: building_ids array
 * - OLD: building_id single
 */
function getUserBuildings(user) {
  const arr = Array.isArray(user?.building_ids) ? user.building_ids : [];
  const single = user?.building_id ? [user.building_id] : [];
  return Array.from(new Set([...arr, ...single].map(String)));
}

/**
 * Resolve building id from multiple sources
 * (params/query/body/requestedBuildingId)
 */
function resolveRequestedBuildingId(req) {
  const fromParams = req.params?.building_id;
  const fromQuery = req.query?.building_id;
  const fromBody = req.body?.building_id;
  const fromRequested = req.requestedBuildingId;

  const candidate =
    fromParams ??
    fromQuery ??
    fromBody ??
    fromRequested ??
    '';

  const s = String(candidate || '').trim();
  return s || '';
}

/**
 * authorizeBuildingParam()
 * - Accepts building_id from:
 *   - req.params.building_id
 *   - req.query.building_id
 *   - req.body.building_id          ✅ NEW (fixes your POST /meters issue)
 *   - req.requestedBuildingId
 */
function authorizeBuildingParam() {
  return function (req, res, next) {
    if (isAdmin(req.user)) return next();

    const allowed = getUserBuildings(req.user);
    if (!allowed.length) {
      return res.status(401).json({ error: 'Unauthorized: No buildings assigned' });
    }

    const requested = resolveRequestedBuildingId(req);
    if (!requested) {
      return res.status(400).json({ error: 'No building specified for authorization' });
    }

    if (!allowed.includes(requested)) {
      return res.status(403).json({ error: 'No access to this building' });
    }

    next();
  };
}

/**
 * attachBuildingScope()
 * - Adds:
 *   - req.restrictToBuildingIds: string[] | null   (null for admin)
 *   - req.restrictToBuildingId:  string | null    (single building if exactly 1; else null) ✅ for older routes
 *   - req.buildingWhere(key): returns a where clause piece for Sequelize
 */
function attachBuildingScope() {
  return function (req, res, next) {
    if (isAdmin(req.user)) {
      req.restrictToBuildingIds = null;
      req.restrictToBuildingId = null;
      req.buildingWhere = () => ({});
      return next();
    }

    const ids = getUserBuildings(req.user);
    if (!ids.length) {
      return res.status(401).json({ error: 'Unauthorized: No buildings assigned' });
    }

    req.restrictToBuildingIds = ids;

    // Backward-compat: some routes expect a singular building id
    req.restrictToBuildingId = (ids.length === 1) ? String(ids[0]) : null;

    req.buildingWhere = (key) => ({ [key]: { [Op.in]: ids } });
    next();
  };
}

/**
 * enforceRecordBuilding(getBuildingIdForRequest)
 * - For routes where building is inferred (e.g., from meter_id).
 * - Calls await getBuildingIdForRequest(req) → building_id, then checks it.
 */
function enforceRecordBuilding(getBuildingIdForRequest) {
  return async function (req, res, next) {
    try {
      if (isAdmin(req.user)) return next();

      const allowed = getUserBuildings(req.user);
      if (!allowed.length) {
        return res.status(401).json({ error: 'Unauthorized: No buildings assigned' });
      }

      const recordBuildingId = await getBuildingIdForRequest(req);
      const candidate = String(recordBuildingId || resolveRequestedBuildingId(req) || '');
      if (!candidate) {
        return res.status(400).json({ error: 'Unable to resolve building for this record' });
      }

      if (!allowed.includes(candidate)) {
        return res.status(403).json({ error: "No access to this record’s building" });
      }

      next();
    } catch (err) {
      console.error('enforceRecordBuilding error:', err);
      res.status(500).json({ error: 'Building authorization failed' });
    }
  };
}

module.exports = {
  authorizeBuildingParam,
  attachBuildingScope,
  enforceRecordBuilding,
};