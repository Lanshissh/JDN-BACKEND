// routes/auth.js
const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
require("dotenv").config();

const User = require("../models/User");
const { comparePassword } = require("../utils/hashPassword");

// ---- helpers ----
function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v == null) return [];
  if (typeof v === "string") {
    // try JSON first
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

/**
 * ✅ Normalize module keys so UI + backend match.
 * Handles legacy camelCase like "readerDevices" -> "reader_devices"
 * and other common aliases.
 */
function normalizeAccessKey(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";

  const lower = s.toLowerCase();

  // known aliases (add more here if you ever rename keys)
  const alias = {
    readerdevices: "reader_devices",
    reader_device: "reader_devices",
    "reader-devices": "reader_devices",

    offlinesubmissions: "offline_submissions",
    offline_submission: "offline_submissions",
    "offline-submissions": "offline_submissions",

    assigntenants: "assign_tenants",
    assign_tenant: "assign_tenants",
    "assign-tenants": "assign_tenants",

    meterreadings: "meter_readings",
    meter_reading: "meter_readings",
    "meter-readings": "meter_readings",

    rateofchange: "rate_of_change",
    "rate-of-change": "rate_of_change",

    // pass-through common keys
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

  // generic camelCase / kebab / spaces -> snake_case
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
}

function normalizeRole(raw) {
  return String(raw ?? "").trim().toLowerCase();
}

function normalizeUtil(raw) {
  return String(raw ?? "").trim().toLowerCase();
}

function uniq(arr) {
  return Array.from(new Set(arr.filter(Boolean)));
}

// POST /auth/login
router.post("/login", async (req, res) => {
  const { user_id, user_password } = req.body;

  if (!user_id || !user_password) {
    return res.status(400).json({ error: "user_id and password required" });
  }

  try {
    const user = await User.findOne({ where: { user_id } });
    if (!user) return res.status(401).json({ error: "No existing credentials" });

    const match = await comparePassword(user_password, user.user_password);
    if (!match) return res.status(401).json({ error: "Invalid credentials" });

    // --- normalize roles ---
    let roles = uniq(asArray(user.user_roles).map(normalizeRole));

    // ✅ Enforce "admin role must be exclusive"
    if (roles.includes("admin")) {
      roles = ["admin"];
    } else {
      // keep only known non-admin roles (and allow combinations)
      const allowed = new Set(["operator", "biller", "reader"]);
      roles = roles.filter((r) => allowed.has(r));
      // if somehow empty, default to operator
      if (!roles.length) roles = ["operator"];
    }

    // --- normalize building scope ---
    const building_ids = roles.includes("admin")
      ? []
      : uniq(asArray(user.building_ids).map((x) => String(x).trim()).filter(Boolean));

    // --- normalize utility roles ---
    const utility_role = roles.includes("admin")
      ? []
      : uniq(asArray(user.utility_role).map(normalizeUtil).filter(Boolean));

    // --- normalize access modules ---
    // ✅ snake_case + aliases (fixes readerDevices -> reader_devices)
    let access_modules = roles.includes("admin")
      ? []
      : uniq(asArray(user.access_modules).map(normalizeAccessKey).filter(Boolean));

    // ✅ Dependency safety:
    // offline_submissions implies meter_readings (approval uses readings)
    if (access_modules.includes("offline_submissions") && !access_modules.includes("meter_readings")) {
      access_modules.push("meter_readings");
      access_modules = uniq(access_modules);
    }

    const payload = {
      user_id: user.user_id,
      user_fullname: user.user_fullname,

      // arrays-only payload
      user_roles: roles,
      building_ids,
      utility_role,
      access_modules,
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRES_IN || "1h",
    });

    res.json({ token });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;