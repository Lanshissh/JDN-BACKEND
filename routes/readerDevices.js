// routes/readerDevices.js
const express = require("express");
const crypto = require("crypto");
const router = express.Router();

const authenticateToken = require("../middleware/authenticateToken");
const authorizeRole = require("../middleware/authorizeRole");

// ✅ SQL Server / Sequelize instance
const { sequelize } = require("../models");

// ✅ Unique-violation detector (SQL Server)
function isUniqueViolation(err) {
  // MSSQL unique constraint errors: 2627, 2601
  const num = err?.original?.number ?? err?.parent?.number;
  if (num === 2627 || num === 2601) return true;

  const msg = String(err?.message || "").toLowerCase();
  return msg.includes("unique") || msg.includes("duplicate");
}

/**
 * ✅ ADMIN creates device manually with SERIAL
 * POST /reader-devices
 * body: { device_name, device_serial, device_info }
 */
router.post("/", authenticateToken, authorizeRole("admin"), async (req, res) => {
  try {
    const { device_name, device_serial, device_info } = req.body || {};

    if (!device_serial || !String(device_serial).trim()) {
      return res.status(400).json({ error: "device_serial is required" });
    }

    const serial = String(device_serial).trim();
    const name = String(device_name || "").trim() || `Device ${serial}`;
    const info = device_info == null ? null : String(device_info).trim();

    // ✅ check serial exists (MSSQL)
    const [existingRows] = await sequelize.query(
      "SELECT TOP 1 * FROM reader_devices WHERE device_serial = ?",
      { replacements: [serial] }
    );
    if (Array.isArray(existingRows) && existingRows.length > 0) {
      return res.status(409).json({ error: "device_serial already exists" });
    }

    const device_token = crypto.randomBytes(24).toString("hex");

    // ✅ insert (start blocked)
    try {
      await sequelize.query(
        `
        INSERT INTO reader_devices
          (device_name, device_serial, device_info, device_token, status, created_at)
        VALUES
          (?, ?, ?, ?, 'blocked', SYSUTCDATETIME())
        `,
        { replacements: [name, serial, info, device_token] }
      );
    } catch (insertErr) {
      if (isUniqueViolation(insertErr)) {
        return res.status(409).json({ error: "device_serial already exists" });
      }
      throw insertErr;
    }

    // ✅ return created row
    const [rows] = await sequelize.query(
      "SELECT TOP 1 * FROM reader_devices WHERE device_serial = ? ORDER BY device_id DESC",
      { replacements: [serial] }
    );

    return res.json(Array.isArray(rows) ? rows[0] : rows);
  } catch (err) {
    console.error("POST /reader-devices error:", err);
    return res.status(500).json({ error: "server error" });
  }
});

/**
 * (Optional) self-register
 * POST /reader-devices/register
 * Keep if needed, but do NOT call this from MeterReadingPanel for admin-only flow
 */
router.post("/register", authenticateToken, async (req, res) => {
  try {
    const { device_name, device_info } = req.body || {};
    const user_id = req.user?.user_id;

    if (!device_name) {
      return res.status(400).json({ error: "device_name is required" });
    }

    const device_token = crypto.randomBytes(24).toString("hex");

    await sequelize.query(
      `
      INSERT INTO reader_devices
        (user_id, device_name, device_info, device_token, status, created_at)
      VALUES
        (?, ?, ?, ?, 'active', SYSUTCDATETIME())
      `,
      { replacements: [user_id, device_name, device_info || null, device_token] }
    );

    return res.json({ device_token, status: "active" });
  } catch (err) {
    console.error("POST /reader-devices/register error:", err);
    return res.status(500).json({ error: "server error" });
  }
});

/**
 * Admin list devices
 * GET /reader-devices
 */
router.get("/", authenticateToken, authorizeRole("admin"), async (req, res) => {
  try {
    const [rows] = await sequelize.query(
      "SELECT * FROM reader_devices ORDER BY device_id DESC"
    );
    return res.json(rows);
  } catch (err) {
    console.error("GET /reader-devices error:", err);
    return res.status(500).json({ error: "server error" });
  }
});

/**
 * Admin block/unblock
 * PATCH /reader-devices/:device_id/status
 * body: { status: "active" | "blocked" }
 */
router.patch(
  "/:device_id/status",
  authenticateToken,
  authorizeRole("admin"),
  async (req, res) => {
    try {
      const { device_id } = req.params;
      const { status } = req.body || {};

      if (!["active", "blocked"].includes(status)) {
        return res.status(400).json({ error: "invalid status" });
      }

      await sequelize.query(
        "UPDATE reader_devices SET status = ? WHERE device_id = ?",
        { replacements: [status, device_id] }
      );

      const [rows] = await sequelize.query(
        "SELECT TOP 1 * FROM reader_devices WHERE device_id = ?",
        { replacements: [device_id] }
      );

      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(404).json({ error: "Device not found" });
      }

      return res.json(rows[0]);
    } catch (err) {
      console.error("PATCH /reader-devices/:device_id/status error:", err);
      return res.status(500).json({ error: "server error" });
    }
  }
);

/**
 * Admin delete device
 * DELETE /reader-devices/:device_id
 */
router.delete(
  "/:device_id",
  authenticateToken,
  authorizeRole("admin"),
  async (req, res) => {
    try {
      const { device_id } = req.params;

      const [rows] = await sequelize.query(
        "SELECT TOP 1 * FROM reader_devices WHERE device_id = ?",
        { replacements: [device_id] }
      );

      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(404).json({ error: "Device not found" });
      }

      await sequelize.query("DELETE FROM reader_devices WHERE device_id = ?", {
        replacements: [device_id],
      });

      return res.json({ ok: true });
    } catch (err) {
      console.error("DELETE /reader-devices/:device_id error:", err);
      return res.status(500).json({ error: "server error" });
    }
  }
);

module.exports = router;