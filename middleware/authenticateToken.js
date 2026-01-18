// middleware/authenticateToken.js
const jwt = require("jsonwebtoken");
require("dotenv").config();

function toIntOrNull(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  if (i <= 0) return null;
  return i;
}

function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v == null) return [];
  // If someone accidentally stored a JSON string in token payload (rare), handle it
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
    // fallback: comma separated
    return v.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return [v];
}

function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ error: "No token provided" });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: "Invalid or expired token" });
    }

    // Keep original payload
    req.user = user || {};

    // Normalize commonly-used fields into arrays for safety/consistency
    req.user.user_roles = asArray(req.user.user_roles);
    req.user.building_ids = asArray(req.user.building_ids);
    req.user.utility_role = asArray(req.user.utility_role);

    // NEW: permissions / checkbox access list
    req.user.access_modules = asArray(req.user.access_modules);

    // Normalize common id fields into guaranteed numeric versions (if possible)
    // (Does NOT change req.user.user_id if it's a string like "USER-1")
    const rawUserId = req.user.user_id ?? req.user.id ?? req.user.userId ?? null;
    const userIdInt = toIntOrNull(rawUserId);

    // Provide stable numeric fields for routes that need INT (like offline_submissions.reader_user_id)
    req.user.user_id_int = userIdInt; // preferred
    req.user.id_int = userIdInt; // alias

    next();
  });
}

module.exports = authenticateToken;