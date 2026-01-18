// middleware/authorizeAccess.js
/**
 * authorizeAccess("meters") -> only allow users who have:
 *  - role includes "admin"  OR
 *  - access_modules includes "meters"
 *
 * Also supports:
 *   authorizeAccess(["scanner","meter_readings"]) // allow if they have ANY of these
 */

function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v == null) return [];
  if (typeof v === "string") {
    // Try JSON first
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
    // fallback comma-separated
    return v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [v];
}

function normalizeKey(s) {
  return String(s || "").trim().toLowerCase();
}

function authorizeAccess(requiredKeyOrKeys) {
  const requiredList = asArray(requiredKeyOrKeys)
    .map(normalizeKey)
    .filter(Boolean);

  return (req, res, next) => {
    // Must have authenticateToken first
    const user = req.user || {};

    const roles = asArray(user.user_roles).map(normalizeKey);
    if (roles.includes("admin")) return next();

    const access = asArray(user.access_modules).map(normalizeKey);

    if (!requiredList.length) {
      return res.status(500).json({ error: "authorizeAccess misconfigured" });
    }

    // allow if user has ANY required key
    const ok = requiredList.some((k) => access.includes(k));
    if (ok) return next();

    return res.status(403).json({
      error: "Forbidden",
      message: `Missing access: ${requiredList.join(" OR ")}`,
    });
  };
}

module.exports = authorizeAccess;