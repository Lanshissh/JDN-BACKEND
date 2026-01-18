// routes/readerDevices.js
// Reader Device Management (READERS ONLY offline sync)
// Admin registers device serial -> server generates token
// Reader resolves token using serial after login

const express = require("express");
const crypto = require("crypto");
const { QueryTypes } = require("sequelize");

const authenticateToken = require("../middleware/authenticateToken");
const authorizeRole = require("../middleware/authorizeRole");
const authorizeAccess = require("../middleware/authorizeAccess"); // ✅ NEW
const sequelize = require("../models"); // same pattern as your other routes

const router = express.Router();

function normalizeSerial(serial) {
  return String(serial || "").trim().toUpperCase();
}

function normalizeStatus(status) {
  return String(status || "").trim().toLowerCase();
}

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

function pickUserId(req) {
  return req.user?.user_id || req.user?.id || null;
}

// All routes require authentication
router.use(authenticateToken);

/**
 * ==========================================================
 * READER: Resolve device
 * ==========================================================
 * IMPORTANT:
 * This must NOT require authorizeAccess("reader_devices"),
 * because readers typically won't be granted that admin module.
 */
router.post("/resolve", authorizeRole("reader"), async (req, res) => {
  try {
    const device_serial = normalizeSerial(req.body?.device_serial);
    const device_name = (req.body?.device_name || "").trim() || null;

    if (!device_serial) {
      return res.status(400).json({ error: "device_serial is required" });
    }

    const rows = await sequelize.query(
      `
      SELECT TOP 1 id, device_serial, device_name, device_token, status
      FROM dbo.reader_devices
      WHERE device_serial = :device_serial
      `,
      {
        replacements: { device_serial },
        type: QueryTypes.SELECT,
      }
    );

    if (!rows.length) {
      return res.status(403).json({
        error: "Device not registered",
        hint: "Ask admin to register this device serial.",
      });
    }

    const row = rows[0];

    if (String(row.status).toLowerCase() !== "active") {
      return res.status(403).json({ error: "Device is blocked" });
    }

    await sequelize.query(
      `
      UPDATE dbo.reader_devices
      SET last_seen_at = GETDATE(),
          device_name = COALESCE(:device_name, device_name),
          updated_at = GETDATE()
      WHERE id = :id
      `,
      {
        replacements: { id: row.id, device_name },
        type: QueryTypes.UPDATE,
      }
    );

    return res.json({
      device: {
        id: row.id,
        device_serial: row.device_serial,
        device_name: device_name || row.device_name,
        device_token: row.device_token,
        status: row.status,
      },
    });
  } catch (err) {
    console.error("reader-devices/resolve error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * ==========================================================
 * READER: Verify device token
 * ==========================================================
 * Used by offline import/export to ensure token is valid and device is active.
 */
router.post("/verify", authorizeRole("reader"), async (req, res) => {
  try {
    const device_token = String(req.body?.device_token || "").trim();
    if (!device_token)
      return res.status(400).json({ error: "device_token is required" });

    const rows = await sequelize.query(
      `
      SELECT TOP 1 id, device_serial, device_name, device_token, status, last_seen_at
      FROM dbo.reader_devices
      WHERE device_token = :device_token
      `,
      {
        replacements: { device_token },
        type: QueryTypes.SELECT,
      }
    );

    if (!rows.length)
      return res.status(403).json({ error: "Invalid device token" });

    const row = rows[0];
    if (String(row.status).toLowerCase() !== "active") {
      return res.status(403).json({ error: "Device is blocked" });
    }

    await sequelize.query(
      `
      UPDATE dbo.reader_devices
      SET last_seen_at = GETDATE(),
          updated_at = GETDATE()
      WHERE id = :id
      `,
      { replacements: { id: row.id }, type: QueryTypes.UPDATE }
    );

    return res.json({
      ok: true,
      device: {
        id: row.id,
        device_serial: row.device_serial,
        device_name: row.device_name,
        status: row.status,
        last_seen_at: row.last_seen_at,
      },
    });
  } catch (err) {
    console.error("reader-devices/verify error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * ==========================================================
 * MANAGEMENT: The routes below require reader_devices access
 * ==========================================================
 */
router.use(authorizeAccess("reader_devices"));

/**
 * MANAGEMENT: Register device
 * POST /reader-devices/register
 * body: { device_serial, device_name? }
 */
router.post("/register", authorizeRole("admin", "operator", "biller"), async (req, res) => {
  try {
    const device_serial = normalizeSerial(req.body?.device_serial);
    const device_name = (req.body?.device_name || "").trim() || null;

    if (!device_serial) {
      return res.status(400).json({ error: "device_serial is required" });
    }

    const existing = await sequelize.query(
      `
      SELECT TOP 1 id, device_serial, device_name, device_token, status
      FROM dbo.reader_devices
      WHERE device_serial = :device_serial
      `,
      {
        replacements: { device_serial },
        type: QueryTypes.SELECT,
      }
    );

    if (existing.length) {
      const row = existing[0];

      if (device_name && device_name !== row.device_name) {
        await sequelize.query(
          `
          UPDATE dbo.reader_devices
          SET device_name = :device_name,
              updated_at = GETDATE()
          WHERE id = :id
          `,
          {
            replacements: { id: row.id, device_name },
            type: QueryTypes.UPDATE,
          }
        );
      }

      return res.json({
        message: "Device already registered",
        device: {
          id: row.id,
          device_serial: row.device_serial,
          device_name: device_name || row.device_name,
          device_token: row.device_token,
          status: row.status,
        },
      });
    }

    const device_token = generateToken();

    const inserted = await sequelize.query(
      `
      INSERT INTO dbo.reader_devices
        (device_serial, device_name, device_token, status, created_at, updated_at)
      OUTPUT INSERTED.id
      VALUES
        (:device_serial, :device_name, :device_token, 'active', GETDATE(), GETDATE())
      `,
      {
        replacements: { device_serial, device_name, device_token },
        type: QueryTypes.INSERT,
      }
    );

    const id = inserted?.[0]?.[0]?.id;

    return res.json({
      message: "Device registered",
      device: {
        id,
        device_serial,
        device_name,
        device_token,
        status: "active",
      },
    });
  } catch (err) {
    console.error("reader-devices/register error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * MANAGEMENT: List devices
 * GET /reader-devices
 */
router.get("/", authorizeRole("admin", "operator", "biller"), async (_req, res) => {
  try {
    const devices = await sequelize.query(
      `
      SELECT id, device_serial, device_name, device_token,
             status, last_seen_at, created_at, updated_at
      FROM dbo.reader_devices
      ORDER BY created_at DESC
      `,
      { type: QueryTypes.SELECT }
    );

    res.json({ devices });
  } catch (err) {
    console.error("reader-devices list error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * MANAGEMENT: Update device
 * PATCH /reader-devices/:id
 * body: { device_name?, status? }
 */
router.patch("/:id", authorizeRole("admin", "operator", "biller"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id))
      return res.status(400).json({ error: "Invalid id" });

    const device_name =
      req.body.device_name !== undefined
        ? String(req.body.device_name).trim() || null
        : undefined;

    const status =
      req.body.status !== undefined ? normalizeStatus(req.body.status) : undefined;

    if (status && !["active", "blocked"].includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    if (device_name === undefined && status === undefined) {
      return res.status(400).json({ error: "Nothing to update" });
    }

    const sets = [];
    const replacements = { id };

    if (device_name !== undefined) {
      sets.push("device_name = :device_name");
      replacements.device_name = device_name;
    }
    if (status !== undefined) {
      sets.push("status = :status");
      replacements.status = status;
    }
    sets.push("updated_at = GETDATE()");

    await sequelize.query(
      `
      UPDATE dbo.reader_devices
      SET ${sets.join(", ")}
      WHERE id = :id
      `,
      { replacements, type: QueryTypes.UPDATE }
    );

    const updated = await sequelize.query(
      `
      SELECT TOP 1 *
      FROM dbo.reader_devices
      WHERE id = :id
      `,
      { replacements: { id }, type: QueryTypes.SELECT }
    );

    if (!updated.length) return res.status(404).json({ error: "Not found" });
    res.json({ device: updated[0] });
  } catch (err) {
    console.error("reader-devices update error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * MANAGEMENT: Reset device token
 * POST /reader-devices/:id/reset-token
 */
router.post("/:id/reset-token", authorizeRole("admin", "operator", "biller"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id))
      return res.status(400).json({ error: "Invalid id" });

    const device_token = generateToken();

    await sequelize.query(
      `
      UPDATE dbo.reader_devices
      SET device_token = :device_token,
          updated_at = GETDATE()
      WHERE id = :id
      `,
      { replacements: { id, device_token }, type: QueryTypes.UPDATE }
    );

    const updated = await sequelize.query(
      `
      SELECT TOP 1 id, device_serial, device_name, device_token, status, last_seen_at
      FROM dbo.reader_devices
      WHERE id = :id
      `,
      { replacements: { id }, type: QueryTypes.SELECT }
    );

    if (!updated.length) return res.status(404).json({ error: "Not found" });

    res.json({
      message: "Device token reset",
      device: updated[0],
    });
  } catch (err) {
    console.error("reader-devices reset-token error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * MANAGEMENT: Delete device
 * DELETE /reader-devices/:id
 */
router.delete("/:id", authorizeRole("admin", "operator", "biller"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id))
      return res.status(400).json({ error: "Invalid id" });

    await sequelize.query(`DELETE FROM dbo.reader_devices WHERE id = :id`, {
      replacements: { id },
      type: QueryTypes.DELETE,
    });

    res.json({ message: "Deleted" });
  } catch (err) {
    console.error("reader-devices delete error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;