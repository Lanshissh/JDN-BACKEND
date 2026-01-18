// routes/users.js
const express = require("express");
const router = express.Router();

// Utilities & middleware
const { hashPassword } = require("../utils/hashPassword");
const authenticateToken = require("../middleware/authenticateToken");
const authorizeRole = require("../middleware/authorizeRole");

// Sequelize
const { Op } = require("sequelize");

// Models
const User = require("../models/User");

// All routes below require a valid token
router.use(authenticateToken);

// ---- helpers ----
const ALLOWED_ROLES = new Set(["admin", "operator", "biller", "reader"]);

// Must match the backend authorizeAccess("<key>") usage
const ALLOWED_ACCESS_MODULES = new Set([
  "meters",
  "buildings",
  "stalls",
  "tenants",
  "assign_tenants",
  "offline_submissions",
  "meter_readings",
  "billing",
  "vat",
  "withholding",
  "reader_devices",
  "rate_of_change",
  "scanner",
]);

function normalizeArray(v) {
  if (Array.isArray(v)) return v;
  if (v == null) return [];
  if (typeof v === "string") {
    // Try JSON first, then fallback to comma-separated
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
    return v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [v];
}

function uniq(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}

/**
 * ✅ Normalize module keys so DB stores consistent snake_case.
 * Handles legacy camelCase like "readerDevices" -> "reader_devices"
 */
function normalizeAccessKey(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";

  const lower = s.toLowerCase();

  const alias = {
    // Reader devices
    readerdevices: "reader_devices",
    reader_device: "reader_devices",
    "reader-devices": "reader_devices",

    // Offline submissions
    offlinesubmissions: "offline_submissions",
    offline_submission: "offline_submissions",
    "offline-submissions": "offline_submissions",

    // Assign tenants
    assigntenants: "assign_tenants",
    assign_tenant: "assign_tenants",
    "assign-tenants": "assign_tenants",

    // Meter readings
    meterreadings: "meter_readings",
    meter_reading: "meter_readings",
    "meter-readings": "meter_readings",

    // Rate of change
    rateofchange: "rate_of_change",
    "rate-of-change": "rate_of_change",

    // Keep common ones (normalized)
    buildings: "buildings",
    stalls: "stalls",
    tenants: "tenants",
    meters: "meters",
    billing: "billing",
    vat: "vat",
    withholding: "withholding",
    scanner: "scanner",
  };

  if (alias[lower]) return alias[lower];

  // Generic camelCase / kebab / spaces -> snake_case
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
}

/**
 * Apply “implied” permissions to prevent UI/API mismatches.
 * - If user can approve offline submissions, they must have meter_readings too
 */
function applyAccessImplications(mods) {
  const set = new Set(mods);

  // Offline submissions approval ultimately writes to dbo.meter_reading,
  // so it should imply meter_readings access.
  if (set.has("offline_submissions")) {
    set.add("meter_readings");
  }

  return Array.from(set);
}

/**
 * ✅ Enforce role-based constraints on access modules (Option B rules).
 * - reader_devices management is allowed for: admin/operator/biller
 * - readers should NOT have reader_devices (management screen)
 */
function applyRoleAccessRules(roles, mods) {
  const roleSet = new Set((roles || []).map((r) => String(r).toLowerCase()));

  // If admin, access modules are ignored anyway (admin has implicit access)
  if (roleSet.has("admin")) return [];

  const set = new Set(mods);

  // Reader role should not have management modules.
  if (roleSet.has("reader")) {
    set.delete("reader_devices");
  }

  // reader_devices only for operator/biller/admin
  if (set.has("reader_devices")) {
    const allowed =
      roleSet.has("operator") || roleSet.has("biller") || roleSet.has("admin");
    if (!allowed) set.delete("reader_devices");
  }

  return Array.from(set);
}

function normalizeAccessModules(v, roles) {
  const arr = normalizeArray(v)
    .map((x) => normalizeAccessKey(x))
    .filter(Boolean);

  const filtered = arr.filter((x) => ALLOWED_ACCESS_MODULES.has(x));

  // Dedupe + implications + role rules
  const implied = applyAccessImplications(uniq(filtered));
  const roleConstrained = applyRoleAccessRules(roles, implied);

  return uniq(roleConstrained);
}

/**
 * Enforce that when 'admin' is present, it must be the ONLY role.
 */
function enforceAdminExclusivity(inputRoles) {
  const roles = normalizeArray(inputRoles)
    .map((x) => String(x).toLowerCase().trim())
    .filter((x) => ALLOWED_ROLES.has(x));

  if (roles.includes("admin")) {
    if (roles.length > 1) {
      return {
        ok: false,
        error:
          "When assigning 'admin', it must be the only role (no multi-role allowed for admin).",
      };
    }
    return { ok: true, roles: ["admin"] };
  }

  // non-admin roles can be multiple (dedupe)
  const deduped = Array.from(new Set(roles));
  return { ok: true, roles: deduped };
}

// ---- routes ----

/** GET all users (admin) */
router.get("/", authorizeRole("admin"), async (_req, res) => {
  try {
    const users = await User.findAll();
    res.json(
      users.map((u) => ({
        user_id: u.user_id,
        user_fullname: u.user_fullname,
        user_roles: Array.isArray(u.user_roles) ? u.user_roles : [],
        building_ids: Array.isArray(u.building_ids) ? u.building_ids : [],
        utility_role: Array.isArray(u.utility_role) ? u.utility_role : [],
        access_modules: Array.isArray(u.access_modules) ? u.access_modules : [],
      }))
    );
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** CREATE user (admin) */
router.post("/", authorizeRole("admin"), async (req, res) => {
  try {
    const {
      user_password,
      user_fullname,
      user_roles: rolesIn,
      building_ids: buildingsIn,
      utility_role: utilitiesIn,
      access_modules: accessIn,
    } = req.body || {};

    if (!user_password || !user_fullname) {
      return res
        .status(400)
        .json({ error: "user_password and user_fullname are required" });
    }

    const roleCheck = enforceAdminExclusivity(rolesIn);
    if (!roleCheck.ok) return res.status(400).json({ error: roleCheck.error });
    const user_roles = roleCheck.roles;

    // Admin has no building/utility/access arrays stored
    const building_ids = user_roles.includes("admin")
      ? []
      : normalizeArray(buildingsIn).map(String).filter(Boolean);

    const utility_role = user_roles.includes("admin")
      ? []
      : normalizeArray(utilitiesIn).map(String).filter(Boolean);

    const access_modules = user_roles.includes("admin")
      ? []
      : normalizeAccessModules(accessIn, user_roles);

    // ✅ non-admin must have at least 1 access module
    if (!user_roles.includes("admin") && access_modules.length === 0) {
      return res.status(400).json({
        error:
          "access_modules is required for non-admin users (select at least 1).",
      });
    }

    // (Optional) ensure non-admin has at least 1 building for scoping
    if (!user_roles.includes("admin") && building_ids.length === 0) {
      return res.status(400).json({
        error: "building_ids is required for non-admin users (select a building).",
      });
    }

    // Build next USER-<n>
    const rows = await User.findAll({
      where: { user_id: { [Op.like]: "USER-%" } },
      attributes: ["user_id"],
      raw: true,
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
      utility_role,
      access_modules,
    });

    res.status(201).json({
      user_id: created.user_id,
      user_fullname: created.user_fullname,
      user_roles: created.user_roles,
      building_ids: created.building_ids,
      utility_role: created.utility_role,
      access_modules: created.access_modules,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** UPDATE user (admin) */
router.put("/:user_id", authorizeRole("admin"), async (req, res) => {
  try {
    const user = await User.findByPk(req.params.user_id);
    if (!user) return res.status(404).json({ error: "User not found" });

    const {
      user_password,
      user_fullname,
      user_roles: rolesIn,
      building_ids: buildingsIn,
      utility_role: utilitiesIn,
      access_modules: accessIn,
    } = req.body || {};

    if (user_fullname !== undefined) user.user_fullname = user_fullname;
    if (user_password) user.user_password = await hashPassword(user_password);

    if (rolesIn !== undefined) {
      const roleCheck = enforceAdminExclusivity(rolesIn);
      if (!roleCheck.ok)
        return res.status(400).json({ error: roleCheck.error });

      user.user_roles = roleCheck.roles;

      if (roleCheck.roles.includes("admin")) {
        user.access_modules = [];
        user.building_ids = [];
        user.utility_role = [];
      }
    }

    const rolesNow = Array.isArray(user.user_roles) ? user.user_roles : [];

    if (buildingsIn !== undefined) {
      user.building_ids = rolesNow.includes("admin")
        ? []
        : normalizeArray(buildingsIn).map(String).filter(Boolean);
    }

    if (utilitiesIn !== undefined) {
      user.utility_role = rolesNow.includes("admin")
        ? []
        : normalizeArray(utilitiesIn).map(String).filter(Boolean);
    }

    if (accessIn !== undefined) {
      user.access_modules = rolesNow.includes("admin")
        ? []
        : normalizeAccessModules(accessIn, rolesNow);
    } else {
      // ✅ even if accessIn not provided, ensure stored access_modules remains normalized
      if (!rolesNow.includes("admin")) {
        user.access_modules = normalizeAccessModules(
          user.access_modules,
          rolesNow
        );
      }
    }

    const accessNow = Array.isArray(user.access_modules) ? user.access_modules : [];

    if (!rolesNow.includes("admin") && accessNow.length === 0) {
      return res.status(400).json({
        error:
          "access_modules is required for non-admin users (select at least 1).",
      });
    }

    if (!rolesNow.includes("admin")) {
      const buildingsNow = Array.isArray(user.building_ids) ? user.building_ids : [];
      if (buildingsNow.length === 0) {
        return res.status(400).json({
          error: "building_ids is required for non-admin users (select a building).",
        });
      }
    }

    await user.save();

    res.json({
      user_id: user.user_id,
      user_fullname: user.user_fullname,
      user_roles: user.user_roles,
      building_ids: user.building_ids,
      utility_role: user.utility_role,
      access_modules: user.access_modules,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** DELETE user (admin) */
router.delete("/:user_id", authorizeRole("admin"), async (req, res) => {
  try {
    const user = await User.findByPk(req.params.user_id);
    if (!user) return res.status(404).json({ error: "User not found" });
    await user.destroy();
    res.json({ message: "User deleted" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;