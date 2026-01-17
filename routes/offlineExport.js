// routes/offlineExport.js
// Offline IMPORT / EXPORT for Reader devices

const express = require("express");
const { QueryTypes } = require("sequelize");

const authenticateToken = require("../middleware/authenticateToken");
const authorizeRole = require("../middleware/authorizeRole");
const sequelize = require("../models");

const router = express.Router();
router.use(authenticateToken);

// ---------------- HELPERS ----------------

function getUserId(req) {
  // Keep as-is; we will stringify where needed
  return req.user?.user_id || req.user?.id || null;
}

function generateReadingId() {
  // example: R-20260114-8F3A9C
  return (
    "R-" +
    new Date().toISOString().slice(0, 10).replace(/-/g, "") +
    "-" +
    Math.random().toString(36).substring(2, 8).toUpperCase()
  );
}

async function requireActiveDevice(device_token) {
  if (!device_token) {
    const e = new Error("Invalid device token");
    e.status = 403;
    throw e;
  }

  const rows = await sequelize.query(
    `
    SELECT TOP 1 id, status, device_serial, device_name
    FROM dbo.reader_devices
    WHERE device_token = :device_token
    `,
    { replacements: { device_token }, type: QueryTypes.SELECT }
  );

  if (!rows.length || String(rows[0].status).toLowerCase() !== "active") {
    const e = new Error("Device not allowed");
    e.status = 403;
    throw e;
  }

  return rows[0];
}

// ---------------- READER IMPORT ----------------
// Reader presses Sync (IMPORT). Device must get a LIGHTWEIGHT package only.
// POST /offlineExport/import { device_token }

router.post("/import", authorizeRole("reader"), async (req, res) => {
  try {
    const { device_token } = req.body;
    const device = await requireActiveDevice(device_token);

    const items = await sequelize.query(
      `
      SELECT
        m.meter_id,
        m.stall_id,
        m.meter_sn,

        -- Classification mapping from meter_type
        CASE
          WHEN LOWER(m.meter_type) LIKE '%electric%' OR LOWER(m.meter_type) LIKE '%power%' THEN 'electric'
          WHEN LOWER(m.meter_type) LIKE '%water%' THEN 'water'
          WHEN LOWER(m.meter_type) LIKE '%lpg%' OR LOWER(m.meter_type) LIKE '%gas%' THEN 'lpg'
          ELSE ISNULL(m.meter_type, 'unknown')
        END AS classification,

        -- Tenant name (via stall -> tenant)
        t.tenant_name,

        -- Previous reading snapshot (latest)
        lr.reading_value AS prev_reading,
        lr.lastread_date AS prev_date,
        lr.image AS prev_image,

        -- QR payload (your QR is meter_id)
        m.meter_id AS qr

      FROM dbo.meter_list m
      LEFT JOIN dbo.stall_list s ON s.stall_id = m.stall_id
      LEFT JOIN dbo.tenant_list t ON t.tenant_id = s.tenant_id

      OUTER APPLY (
        SELECT TOP 1 reading_value, lastread_date, image
        FROM dbo.meter_reading
        WHERE meter_id = m.meter_id
        ORDER BY lastread_date DESC
      ) lr

      ORDER BY m.meter_id ASC
      `,
      { type: QueryTypes.SELECT }
    );

    return res.json({
      package: {
        generated_at: new Date().toISOString(),
        device_serial: device.device_serial || null,
        device_name: device.device_name || null,
        items: items.map((x) => ({
          meter_id: x.meter_id,
          stall_id: x.stall_id ?? null,
          meter_number: x.meter_sn ?? null,
          tenant_name: x.tenant_name ?? null,
          classification: x.classification ?? null,
          prev_reading: x.prev_reading ?? null,
          prev_date: x.prev_date ?? null,
          prev_image: x.prev_image ?? null,
          qr: x.qr ?? x.meter_id,
        })),
      },
    });
  } catch (err) {
    console.error("offline import error", err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ---------------- READER EXPORT ----------------
// Reader presses Sync again (EXPORT). Upload readings to offline_submissions.
// POST /offlineExport/export { device_token, readings: [...] }

router.post("/export", authorizeRole("reader"), async (req, res) => {
  try {
    const { device_token, readings } = req.body;
    const device = await requireActiveDevice(device_token);

    // IMPORTANT:
    // dbo.offline_submissions.reader_user_id is NOW NVARCHAR
    // so we store the user id as a STRING.
    const reader_id = String(getUserId(req) || "").trim();
    if (!reader_id) {
      return res.status(400).json({ error: "Invalid user token" });
    }

    if (!Array.isArray(readings) || readings.length === 0) {
      return res.status(400).json({ error: "No readings provided" });
    }

    let count = 0;

    for (const r of readings) {
      if (!r || !r.meter_id || !r.lastread_date) {
        return res.status(400).json({ error: "Invalid reading payload" });
      }

      // meter_id in your system is NVARCHAR (e.g., "MTR-1")
      const meter_id = String(r.meter_id).trim();

      // Ensure reading_value becomes a number for DECIMAL(18,4)
      const reading_value =
        r.reading_value === null ||
        r.reading_value === undefined ||
        r.reading_value === ""
          ? null
          : Number(r.reading_value);

      if (reading_value !== null && !Number.isFinite(reading_value)) {
        return res.status(400).json({
          error: `Invalid reading_value for meter ${meter_id}. Got: ${String(
            r.reading_value
          )}`,
        });
      }

      // SQL DATE expects YYYY-MM-DD; if you send ISO, slice to date part
      const reading_date = String(r.lastread_date).slice(0, 10);

      await sequelize.query(
        `
        INSERT INTO dbo.offline_submissions
          (device_id, reader_user_id, meter_id, reading_value, reading_date,
           remarks, image_base64, submitted_at, status)
        VALUES
          (:device_id, :reader_user_id, :meter_id, :reading_value, :reading_date,
           :remarks, :image, GETDATE(), 'pending')
        `,
        {
          replacements: {
            device_id: device.id, // INT
            reader_user_id: reader_id, // NVARCHAR
            meter_id, // NVARCHAR
            reading_value, // DECIMAL(18,4)
            reading_date, // DATE
            remarks: r.remarks || null,
            image: r.image || null,
          },
          type: QueryTypes.INSERT,
        }
      );

      count++;
    }

    res.json({ message: "Offline readings uploaded", count });
  } catch (err) {
    console.error("offline export error", err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ---------------- ADMIN: LIST PENDING ----------------
// GET /offlineExport/pending

router.get("/pending", authorizeRole("admin"), async (_req, res) => {
  try {
    const rows = await sequelize.query(
      `
      SELECT
        os.id,
        os.device_id,
        rd.device_serial,
        rd.device_name,
        os.reader_user_id,
        os.meter_id,
        os.reading_value,
        os.reading_date,
        os.remarks,
        os.image_base64,
        os.submitted_at,
        os.status
      FROM dbo.offline_submissions os
      LEFT JOIN dbo.reader_devices rd ON rd.id = os.device_id
      WHERE os.status = 'pending'
      ORDER BY os.submitted_at DESC
      `,
      { type: QueryTypes.SELECT }
    );

    return res.json({ submissions: rows });
  } catch (err) {
    console.error("offlineExport/pending error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ---------------- ADMIN APPROVE ----------------
// POST /offlineExport/approve/:id

router.post("/approve/:id", authorizeRole("admin"), async (req, res) => {
  try {
    const id = Number(req.params.id);

    // IMPORTANT:
    // dbo.offline_submissions.approved_by is NOW NVARCHAR
    const admin_id = String(getUserId(req) || "").trim();
    if (!admin_id) {
      return res.status(400).json({ error: "Invalid admin token" });
    }

    const rows = await sequelize.query(
      `SELECT * FROM dbo.offline_submissions WHERE id = :id`,
      { replacements: { id }, type: QueryTypes.SELECT }
    );

    if (!rows.length) return res.status(404).json({ error: "Not found" });

    const s = rows[0];
    if (s.status !== "pending") {
      return res.status(400).json({ error: "Already processed" });
    }

    // NOTE:
    // This will succeed as long as dbo.meter_reading.read_by accepts the same type
    // as s.reader_user_id (string). If dbo.meter_reading.read_by is still INT,
    // you'll need to ALTER it to NVARCHAR too.
    await sequelize.query(
      `
      INSERT INTO dbo.meter_reading
        (reading_id, meter_id, reading_value, read_by,
         lastread_date, last_updated, updated_by,
         remarks, image)
      VALUES
        (:reading_id, :meter_id, :reading_value, :read_by,
         :lastread_date, SYSDATETIMEOFFSET(), :updated_by,
         :remarks, :image)
      `,
      {
        replacements: {
          reading_id: generateReadingId(),
          meter_id: s.meter_id,
          reading_value: s.reading_value,
          read_by: s.reader_user_id,
          lastread_date: s.reading_date,
          updated_by: admin_id,
          remarks: s.remarks,
          image: s.image_base64,
        },
        type: QueryTypes.INSERT,
      }
    );

    await sequelize.query(
      `
      UPDATE dbo.offline_submissions
      SET status = 'approved',
          approved_at = GETDATE(),
          approved_by = :admin
      WHERE id = :id
      `,
      {
        replacements: { id, admin: admin_id },
        type: QueryTypes.UPDATE,
      }
    );

    res.json({ message: "Approved and saved to meter_reading" });
  } catch (err) {
    console.error("approve error", err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------- ADMIN REJECT ----------------
// POST /offlineExport/reject/:id

router.post("/reject/:id", authorizeRole("admin"), async (req, res) => {
  try {
    const id = Number(req.params.id);

    // dbo.offline_submissions.approved_by is NOW NVARCHAR
    const admin_id = String(getUserId(req) || "").trim();
    if (!admin_id) {
      return res.status(400).json({ error: "Invalid admin token" });
    }

    await sequelize.query(
      `
      UPDATE dbo.offline_submissions
      SET status = 'rejected',
          approved_at = GETDATE(),
          approved_by = :admin
      WHERE id = :id AND status = 'pending'
      `,
      {
        replacements: { id, admin: admin_id },
        type: QueryTypes.UPDATE,
      }
    );

    res.json({ message: "Rejected" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;