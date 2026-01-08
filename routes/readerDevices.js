// routes/readerDevices.js
const express = require("express");
const crypto = require("crypto");
const router = express.Router();

const authenticateToken = require("../middleware/authenticateToken");
const authorizeRole = require("../middleware/authorizeRole");
const sequelize = require("../models");

function generateToken() {
  return crypto.randomBytes(24).toString("hex"); // 48 chars
}

async function generateUniqueToken(maxTries = 5) {
  for (let i = 0; i < maxTries; i++) {
    const token = generateToken();

    // ✅ MSSQL-safe
    const [rows] = await sequelize.query(
      `SELECT device_id FROM reader_devices WHERE device_token = @p0`,
      { replacements: [token] }
    );

    if (!rows || rows.length === 0) return token;
  }
  throw new Error("Failed to generate unique device token");
}

// ✅ 1) ADMIN registers device by SERIAL (creates token)
router.post("/", authenticateToken, authorizeRole("admin"), async (req, res) => {
  try {
    const { device_serial, device_name, device_info } = req.body || {};

    if (!device_serial || !String(device_serial).trim()) {
      return res.status(400).json({ error: "device_serial is required" });
    }
    if (!device_name || !String(device_name).trim()) {
      return res.status(400).json({ error: "device_name is required" });
    }

    const serial = String(device_serial).trim();
    const name = String(device_name).trim();
    const info = device_info ? String(device_info).trim() : null;

    // ✅ MSSQL-safe
    const [existing] = await sequelize.query(
      `SELECT device_id FROM reader_devices WHERE device_serial = @p0`,
      { replacements: [serial] }
    );
    if (existing && existing.length > 0) {
      return res.status(409).json({ error: "Device serial already registered" });
    }

    const device_token = await generateUniqueToken();

    // ✅ MSSQL-safe insert
    await sequelize.query(
      `
      INSERT INTO reader_devices
        (device_serial, device_name, device_info, device_token, status, created_at)
      VALUES
        (@p0, @p1, @p2, @p3, 'active', SYSUTCDATETIME())
      `,
      { replacements: [serial, name, info, device_token] }
    );

    const [rows] = await sequelize.query(
      `SELECT * FROM reader_devices WHERE device_serial = @p0`,
      { replacements: [serial] }
    );

    return res.status(201).json(rows?.[0] || null);
  } catch (err) {
    console.error("readerDevices POST / error:", err);
    return res.status(500).json({ error: err?.message || "server error" });
  }
});

// ✅ 2) READER resolves token by device serial (after login)
router.post("/resolve", authenticateToken, async (req, res) => {
  try {
    const { device_serial, device_info, device_name } = req.body || {};

    if (!device_serial || !String(device_serial).trim()) {
      return res.status(400).json({ error: "device_serial is required" });
    }

    const serial = String(device_serial).trim();
    const info = device_info ? String(device_info).trim() : null;
    const name = device_name ? String(device_name).trim() : null;

    const [rows] = await sequelize.query(
      `SELECT * FROM reader_devices WHERE device_serial = @p0`,
      { replacements: [serial] }
    );

    if (!rows || rows.length === 0) {
      return res.status(403).json({ error: "Device not registered" });
    }

    const device = rows[0];
    if (String(device.status).toLowerCase() !== "active") {
      return res.status(403).json({ error: "Device is blocked" });
    }

    await sequelize.query(
      `
      UPDATE reader_devices
      SET
        last_used_at = SYSUTCDATETIME(),
        device_info = COALESCE(@p0, device_info),
        device_name = COALESCE(@p1, device_name)
      WHERE device_id = @p2
      `,
      { replacements: [info, name, device.device_id] }
    );

    const [updated] = await sequelize.query(
      `SELECT * FROM reader_devices WHERE device_id = @p0`,
      { replacements: [device.device_id] }
    );

    return res.json(updated?.[0] || null);
  } catch (err) {
    console.error("readerDevices POST /resolve error:", err);
    return res.status(500).json({ error: err?.message || "server error" });
  }
});

// ✅ 3) Admin list of all devices (THIS is what the UI needs)
router.get("/", authenticateToken, authorizeRole("admin"), async (_req, res) => {
  try {
    const [rows] = await sequelize.query(
      `SELECT * FROM reader_devices ORDER BY device_id DESC`
    );
    return res.json(rows || []);
  } catch (err) {
    console.error("readerDevices GET / error:", err);
    return res.status(500).json({ error: err?.message || "server error" });
  }
});

// ✅ 4) Block / unblock
router.patch(
  "/:device_id/status",
  authenticateToken,
  authorizeRole("admin"),
  async (req, res) => {
    try {
      const { status } = req.body || {};
      const device_id = Number(req.params.device_id);

      if (!Number.isFinite(device_id)) {
        return res.status(400).json({ error: "invalid device_id" });
      }
      if (!["active", "blocked"].includes(String(status))) {
        return res.status(400).json({ error: "invalid status" });
      }

      await sequelize.query(
        `UPDATE reader_devices SET status = @p0 WHERE device_id = @p1`,
        { replacements: [status, device_id] }
      );

      const [rows] = await sequelize.query(
        `SELECT * FROM reader_devices WHERE device_id = @p0`,
        { replacements: [device_id] }
      );

      if (!rows || rows.length === 0) {
        return res.status(404).json({ error: "Device not found" });
      }

      return res.json(rows[0]);
    } catch (err) {
      console.error("readerDevices PATCH /:id/status error:", err);
      return res.status(500).json({ error: err?.message || "server error" });
    }
  }
);

// ✅ 5) Delete device
router.delete(
  "/:device_id",
  authenticateToken,
  authorizeRole("admin"),
  async (req, res) => {
    try {
      const device_id = Number(req.params.device_id);

      if (!Number.isFinite(device_id)) {
        return res.status(400).json({ error: "invalid device_id" });
      }

      const [rows] = await sequelize.query(
        `SELECT * FROM reader_devices WHERE device_id = @p0`,
        { replacements: [device_id] }
      );
      if (!rows || rows.length === 0) {
        return res.status(404).json({ error: "Device not found" });
      }

      await sequelize.query(
        `DELETE FROM reader_devices WHERE device_id = @p0`,
        { replacements: [device_id] }
      );

      return res.json({ success: true, deleted_id: device_id });
    } catch (err) {
      console.error("readerDevices DELETE /:id error:", err);
      return res.status(500).json({ error: err?.message || "server error" });
    }
  }
);

module.exports = router;