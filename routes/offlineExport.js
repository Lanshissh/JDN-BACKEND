const express = require("express");
const router = express.Router();

const authenticateToken = require("../middleware/authenticateToken");
const authorizeRole = require("../middleware/authorizeRole");
const sequelize = require("../models");

/**
 * Helper: validate device token (active only)
 */
async function requireActiveDevice(device_token) {
  const [rows] = await sequelize.query(
    `SELECT * FROM reader_devices WHERE device_token = ?`,
    { replacements: [device_token] }
  );

  if (!rows || rows.length === 0) {
    return { ok: false, status: 403, error: "Invalid device token" };
  }

  const device = rows[0];
  if (device.status !== "active") {
    return { ok: false, status: 403, error: "Device is blocked" };
  }

  return { ok: true, device };
}

async function touchDeviceLastUsed(device_id) {
  try {
    await sequelize.query(
      `UPDATE reader_devices SET last_used_at = SYSUTCDATETIME() WHERE device_id = ?`,
      { replacements: [device_id] }
    );
  } catch (e) {
    // don't block primary flow if this fails
    console.warn("touchDeviceLastUsed failed:", e?.message || e);
  }
}

/**
 * =========================================================
 * POST /offlineExport/import
 * Download offline dataset for reading (token gated)
 *
 * Returns: meters + stalls + tenants (minimal fields)
 * =========================================================
 */
router.post("/import", authenticateToken, async (req, res) => {
  try {
    const { device_token } = req.body || {};

    if (!device_token) {
      return res.status(400).json({ error: "device_token missing" });
    }

    const dev = await requireActiveDevice(device_token);
    if (!dev.ok) return res.status(dev.status).json({ error: dev.error });

    // ✅ Use your actual table names from SSMS
    const [meters] = await sequelize.query(
      `SELECT meter_id, stall_id, meter_sn, meter_type FROM meter_list`
    );

    const [stalls] = await sequelize.query(
      `SELECT stall_id, building_id, tenant_id FROM stall_list`
    );

    const [tenants] = await sequelize.query(
      `SELECT tenant_id, tenant_name FROM tenant_list`
    );

    await touchDeviceLastUsed(dev.device.device_id);

    return res.json({
      device: {
        device_id: dev.device.device_id,
        device_name: dev.device.device_name,
        device_serial: dev.device.device_serial,
      },
      data: { meters, stalls, tenants },
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error("offlineExport/import error:", err);
    return res.status(500).json({ error: "server error" });
  }
});

/**
 * =========================================================
 * POST /offlineExport/export
 * Reader exports OFFLINE readings -> STAGING table
 * =========================================================
 */
router.post("/export", authenticateToken, async (req, res) => {
  try {
    const { device_token, readings } = req.body || {};

    if (!device_token) {
      return res.status(400).json({ error: "device_token missing" });
    }

    if (!Array.isArray(readings) || readings.length === 0) {
      return res.status(400).json({ error: "readings must be a non-empty array" });
    }

    // validate device
    const dev = await requireActiveDevice(device_token);
    if (!dev.ok) {
      return res.status(dev.status).json({ error: dev.error });
    }

    // validate readings
    for (const r of readings) {
      if (!r.meter_id || typeof r.reading_value !== "number" || !r.lastread_date) {
        return res.status(400).json({ error: "Invalid reading payload" });
      }
    }

    // store full payload (including remarks/image if present)
    const payload_json = JSON.stringify(readings);

    // insert into STAGING table
    await sequelize.query(
      `
      INSERT INTO offline_submissions
        (device_id, submitted_by, payload_json, status)
      VALUES
        (?, ?, ?, 'submitted')
      `,
      {
        replacements: [dev.device.device_id, req.user.user_id, payload_json],
      }
    );

    await touchDeviceLastUsed(dev.device.device_id);

    const [rows] = await sequelize.query(
      `
      SELECT TOP 1 *
      FROM offline_submissions
      WHERE device_id = ? AND submitted_by = ?
      ORDER BY submission_id DESC
      `,
      { replacements: [dev.device.device_id, req.user.user_id] }
    );

    return res.json({
      submission_id: rows?.[0]?.submission_id,
      received: readings.length,
      status: "submitted",
    });
  } catch (err) {
    console.error("offlineExport/export error:", err);
    return res.status(500).json({ error: "server error" });
  }
});

/**
 * =========================================================
 * GET /offlineExport/submissions
 * Admin: view all offline submissions
 * =========================================================
 */
router.get(
  "/submissions",
  authenticateToken,
  authorizeRole("admin"),
  async (_req, res) => {
    try {
      const [rows] = await sequelize.query(
        `
        SELECT
          s.submission_id,
          s.submitted_at,
          s.status,
          s.submitted_by,
          s.approved_by,
          s.approved_at,
          s.reject_reason,
          d.device_name,
          d.device_serial
        FROM offline_submissions s
        JOIN reader_devices d ON d.device_id = s.device_id
        ORDER BY s.submission_id DESC
        `
      );

      return res.json(rows);
    } catch (err) {
      console.error("offlineExport/submissions error:", err);
      return res.status(500).json({ error: "server error" });
    }
  }
);

/**
 * =========================================================
 * POST /offlineExport/submissions/:id/approve
 * Admin approves -> commits to meter_reading
 *
 * Improvements:
 * - uses a transaction
 * - re-checks status inside the transaction
 * - validates payload
 * =========================================================
 */
router.post(
  "/submissions/:id/approve",
  authenticateToken,
  authorizeRole("admin"),
  async (req, res) => {
    const t = await sequelize.transaction();
    try {
      const submissionId = req.params.id;

      const [rows] = await sequelize.query(
        `SELECT * FROM offline_submissions WITH (UPDLOCK, ROWLOCK) WHERE submission_id = ?`,
        { replacements: [submissionId], transaction: t }
      );

      if (!rows || rows.length === 0) {
        await t.rollback();
        return res.status(404).json({ error: "Submission not found" });
      }

      const submission = rows[0];

      if (submission.status !== "submitted") {
        await t.rollback();
        return res
          .status(400)
          .json({ error: `Cannot approve status=${submission.status}` });
      }

      const readings = JSON.parse(submission.payload_json || "[]");
      if (!Array.isArray(readings) || readings.length === 0) {
        await t.rollback();
        return res.status(400).json({ error: "Empty payload" });
      }

      let inserted = 0;

      for (const r of readings) {
        // strict validation
        if (!r.meter_id || typeof r.reading_value !== "number" || !r.lastread_date) continue;

        await sequelize.query(
          `
          INSERT INTO meter_reading
            (meter_id, reading_value, lastread_date, read_by, last_updated, updated_by)
          VALUES
            (?, ?, ?, ?, SYSUTCDATETIME(), ?)
          `,
          {
            replacements: [
              r.meter_id,
              r.reading_value,
              r.lastread_date,
              submission.submitted_by,
              submission.submitted_by,
            ],
            transaction: t,
          }
        );

        inserted += 1;
      }

      await sequelize.query(
        `
        UPDATE offline_submissions
        SET status='approved',
            approved_by=?,
            approved_at=SYSUTCDATETIME()
        WHERE submission_id=?
        `,
        { replacements: [req.user.user_id, submissionId], transaction: t }
      );

      await t.commit();

      return res.json({
        success: true,
        committed: inserted,
        total_in_payload: readings.length,
      });
    } catch (err) {
      try {
        await t.rollback();
      } catch {}
      console.error("offlineExport/approve error:", err);
      return res.status(500).json({ error: "server error" });
    }
  }
);

/**
 * =========================================================
 * POST /offlineExport/submissions/:id/reject
 * Admin rejects submission
 * =========================================================
 */
router.post(
  "/submissions/:id/reject",
  authenticateToken,
  authorizeRole("admin"),
  async (req, res) => {
    try {
      const submissionId = req.params.id;
      const { reason } = req.body || {};

      await sequelize.query(
        `
        UPDATE offline_submissions
        SET status='rejected',
            approved_by=?,
            approved_at=SYSUTCDATETIME(),
            reject_reason=?
        WHERE submission_id=? AND status='submitted'
        `,
        {
          replacements: [
            req.user.user_id,
            reason || "Rejected by admin",
            submissionId,
          ],
        }
      );

      return res.json({ success: true });
    } catch (err) {
      console.error("offlineExport/reject error:", err);
      return res.status(500).json({ error: "server error" });
    }
  }
);

module.exports = router;