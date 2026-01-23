// routes/offlineExport.js
// Offline IMPORT / EXPORT for Reader devices

const express = require("express");
const { QueryTypes } = require("sequelize");

const authenticateToken = require("../middleware/authenticateToken");
const authorizeRole = require("../middleware/authorizeRole");
const authorizeAccess = require("../middleware/authorizeAccess");
const sequelize = require("../models");

const router = express.Router();

router.use(authenticateToken);

// ✅ Allow either permission:
// - readers need meter_readings to import/export
// - approvers may have offline_submissions (UI) which implies meter_readings (users.js fix)
router.use(authorizeAccess(["meter_readings", "offline_submissions"]));

// ---------------- HELPERS ----------------

function getUserId(req) {
  return req.user?.user_id || req.user?.id || null;
}

/**
 * Extract building scope from JWT payload.
 * Supports:
 * - building_ids: ["B1","B2"]
 * - building_id: "B1"
 */
function getUserBuildingIds(req) {
  const u = req.user || {};
  const raw =
    u.building_ids ??
    u.buildings ??
    u.buildingIds ??
    (u.building_id ? [u.building_id] : []);

  let arr = [];
  if (Array.isArray(raw)) arr = raw;
  else if (typeof raw === "string" && raw.trim()) {
    // allow JSON string or csv
    const s = raw.trim();
    try {
      const parsed = JSON.parse(s);
      arr = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      arr = s.split(",").map((x) => x.trim());
    }
  } else if (raw != null) {
    arr = [raw];
  }

  // normalize to trimmed strings
  return arr
    .map((x) => String(x ?? "").trim())
    .filter(Boolean);
}

/**
 * Build a safe IN-clause with named replacements:
 *  buildInClause("B", ["A","C"])
 *   -> { clause: ":B0,:B1", replacements: { B0:"A", B1:"C" } }
 */
function buildInClause(prefix, values) {
  const reps = {};
  const keys = values.map((v, i) => {
    const k = `${prefix}${i}`;
    reps[k] = v;
    return `:${k}`;
  });
  return { clause: keys.join(", "), replacements: reps };
}

/**
 * Offline submissions used to generate "R-YYYYMMDD-XXXXXX".
 * We KEEP this helper in case you still want a local/offline reference,
 * but APPROVAL will now generate MR-### instead.
 */
function generateOfflineRefId() {
  return (
    "R-" +
    new Date().toISOString().slice(0, 10).replace(/-/g, "") +
    "-" +
    Math.random().toString(36).substring(2, 8).toUpperCase()
  );
}

/**
 * ✅ Generate next MR-### safely (SQL Server) using locks inside a transaction.
 * - Uses UPDLOCK + HOLDLOCK so concurrent approvals won't create same MR number.
 * - Reads max numeric part from existing MR-* ids.
 */
async function getNextMrReadingId(t) {
  const rows = await sequelize.query(
    `
    SELECT TOP 1 reading_id
    FROM dbo.meter_reading WITH (UPDLOCK, HOLDLOCK)
    WHERE reading_id LIKE 'MR-%'
    ORDER BY TRY_CONVERT(INT, SUBSTRING(reading_id, 4, 50)) DESC
    `,
    { type: QueryTypes.SELECT, transaction: t }
  );

  const lastId = rows?.[0]?.reading_id ? String(rows[0].reading_id) : "";
  const m = /^MR-(\d+)$/i.exec(lastId);
  const lastNum = m ? Number(m[1]) : 0;
  const nextNum = Number.isFinite(lastNum) ? lastNum + 1 : 1;

  return `MR-${nextNum}`;
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
// POST /offlineExport/import { device_token }
router.post("/import", authorizeRole("reader"), async (req, res) => {
  try {
    const { device_token } = req.body;
    const device = await requireActiveDevice(device_token);

    // ✅ Scope meters by the reader's assigned building_ids from JWT
    const buildingIds = getUserBuildingIds(req);

    // Build optional WHERE clause
    let whereSql = "";
    let whereReps = {};

    if (buildingIds.length > 0) {
      const { clause, replacements } = buildInClause("b", buildingIds);
      // only include meters whose stall belongs to allowed buildings
      whereSql = `WHERE s.building_id IN (${clause})`;
      whereReps = replacements;
    }
    // If buildingIds is empty, we DO NOT filter (fallback behavior)

    const items = await sequelize.query(
      `
      SELECT
        m.meter_id,
        m.stall_id,
        m.meter_sn,
        s.building_id,

        CASE
          WHEN LOWER(m.meter_type) LIKE '%electric%' OR LOWER(m.meter_type) LIKE '%power%' THEN 'electric'
          WHEN LOWER(m.meter_type) LIKE '%water%' THEN 'water'
          WHEN LOWER(m.meter_type) LIKE '%lpg%' OR LOWER(m.meter_type) LIKE '%gas%' THEN 'lpg'
          ELSE ISNULL(m.meter_type, 'unknown')
        END AS classification,

        t.tenant_name,

        lr1.reading_value AS prev_reading,
        lr1.lastread_date AS prev_date,
        lr1.image AS prev_image,

        lr2.reading_value AS prev2_reading,
        lr2.lastread_date AS prev2_date,
        lr2.image AS prev2_image,

        m.meter_id AS qr

      FROM dbo.meter_list m
      LEFT JOIN dbo.stall_list s ON s.stall_id = m.stall_id
      LEFT JOIN dbo.tenant_list t ON t.tenant_id = s.tenant_id

      OUTER APPLY (
        SELECT TOP 1 reading_value, lastread_date, image
        FROM dbo.meter_reading
        WHERE meter_id = m.meter_id
        ORDER BY lastread_date DESC
      ) lr1

      OUTER APPLY (
        SELECT TOP 1 reading_value, lastread_date, image
        FROM dbo.meter_reading
        WHERE meter_id = m.meter_id
          AND lr1.lastread_date IS NOT NULL
          AND lastread_date < lr1.lastread_date
        ORDER BY lastread_date DESC
      ) lr2

      ${whereSql}

      ORDER BY m.meter_id ASC
      `,
      {
        type: QueryTypes.SELECT,
        replacements: {
          ...whereReps,
        },
      }
    );

    return res.json({
      package: {
        generated_at: new Date().toISOString(),
        device_serial: device.device_serial || null,
        device_name: device.device_name || null,
        scope: {
          building_ids: buildingIds,
        },
        items: (items || []).map((x) => ({
          meter_id: x.meter_id,
          stall_id: x.stall_id ?? null,
          building_id: x.building_id ?? null, // ✅ NEW (helps client filtering)
          meter_number: x.meter_sn ?? null,
          tenant_name: x.tenant_name ?? null,
          classification: x.classification ?? null,

          prev_reading: x.prev_reading ?? null,
          prev_date: x.prev_date ?? null,
          prev_image: x.prev_image ?? null,

          prev2_reading: x.prev2_reading ?? null,
          prev2_date: x.prev2_date ?? null,
          prev2_image: x.prev2_image ?? null,

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
// POST /offlineExport/export { device_token, readings: [...] }
router.post("/export", authorizeRole("reader"), async (req, res) => {
  try {
    const { device_token, readings } = req.body;
    const device = await requireActiveDevice(device_token);

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

      const meter_id = String(r.meter_id).trim();

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
            device_id: device.id,
            reader_user_id: reader_id,
            meter_id,
            reading_value,
            reading_date,
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

// ---------------- APPROVER: LIST PENDING ----------------
// ✅ allow admin/operator/biller to view pending if they have access
router.get(
  "/pending",
  authorizeRole("admin", "operator", "biller"),
  async (_req, res) => {
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
  }
);

// ---------------- APPROVER: APPROVE ----------------
// ✅ allow admin/operator/biller to approve if they have access
router.post(
  "/approve/:id",
  authorizeRole("admin", "operator", "biller"),
  async (req, res) => {
    try {
      const id = Number(req.params.id);

      const approver_id = String(getUserId(req) || "").trim();
      if (!approver_id) {
        return res.status(400).json({ error: "Invalid token" });
      }

      // ✅ Transaction to prevent duplicate MR numbers during concurrent approvals
      const result = await sequelize.transaction(async (t) => {
        const rows = await sequelize.query(
          `SELECT * FROM dbo.offline_submissions WITH (UPDLOCK, HOLDLOCK) WHERE id = :id`,
          { replacements: { id }, type: QueryTypes.SELECT, transaction: t }
        );

        if (!rows.length) {
          const e = new Error("Not found");
          e.status = 404;
          throw e;
        }

        const s = rows[0];
        if (String(s.status).toLowerCase() !== "pending") {
          const e = new Error("Already processed");
          e.status = 400;
          throw e;
        }

        // ✅ Generate MR-### instead of R-YYYY...
        const nextMrId = await getNextMrReadingId(t);

        // Optional: mark remarks clearly as offline-origin (keeps audit in existing schema)
        const baseRemarks = s.remarks ? String(s.remarks) : "";
        const offlineTag = "[OFFLINE]";
        const remarks =
          baseRemarks && baseRemarks.includes(offlineTag)
            ? baseRemarks
            : baseRemarks
            ? `${baseRemarks} ${offlineTag}`
            : offlineTag;

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
              reading_id: nextMrId,
              meter_id: s.meter_id,
              reading_value: s.reading_value,
              read_by: s.reader_user_id,
              lastread_date: s.reading_date,
              updated_by: approver_id,
              remarks,
              image: s.image_base64,
            },
            type: QueryTypes.INSERT,
            transaction: t,
          }
        );

        await sequelize.query(
          `
        UPDATE dbo.offline_submissions
        SET status = 'approved',
            approved_at = GETDATE(),
            approved_by = :approver
        WHERE id = :id
        `,
          {
            replacements: { id, approver: approver_id },
            type: QueryTypes.UPDATE,
            transaction: t,
          }
        );

        return { reading_id: nextMrId };
      });

      // ✅ Return the created MR id so UI can show "MR-###" immediately
      return res.json({
        message: "Approved and saved to meter_reading",
        reading_id: result.reading_id,
      });
    } catch (err) {
      console.error("approve error", err);
      res.status(err.status || 500).json({ error: err.message });
    }
  }
);

// ---------------- APPROVER: REJECT ----------------
// ✅ allow admin/operator/biller to reject if they have access
router.post(
  "/reject/:id",
  authorizeRole("admin", "operator", "biller"),
  async (req, res) => {
    try {
      const id = Number(req.params.id);

      const approver_id = String(getUserId(req) || "").trim();
      if (!approver_id) {
        return res.status(400).json({ error: "Invalid token" });
      }

      await sequelize.query(
        `
      UPDATE dbo.offline_submissions
      SET status = 'rejected',
          approved_at = GETDATE(),
          approved_by = :approver
      WHERE id = :id AND status = 'pending'
      `,
        {
          replacements: { id, approver: approver_id },
          type: QueryTypes.UPDATE,
        }
      );

      res.json({ message: "Rejected" });
    } catch (err) {
      console.error("reject error", err);
      res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;