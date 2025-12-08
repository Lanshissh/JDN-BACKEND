const express = require("express");
const router = express.Router();
const authenticateToken = require("../middleware/authenticateToken");
const sequelize = require("../models");

// POST /offline/export
router.post("/export", authenticateToken, async (req, res) => {
  try {
    const { device_token, readings } = req.body;

    if (!device_token) return res.status(400).json({ error: "device_token missing" });
    if (!Array.isArray(readings)) return res.status(400).json({ error: "readings must be array" });

    // Validate device
    const [deviceRows] = await sequelize.query(
      `SELECT * FROM reader_devices WHERE device_token = ? AND status = 'active'`,
      { replacements: [device_token] }
    );

    if (deviceRows.length === 0)
      return res.status(403).json({ error: "Invalid or blocked device" });

    // Insert readings
    for (let r of readings) {
      await sequelize.query(
        `
          INSERT INTO meter_reading 
            (meter_id, reading_value, lastread_date, read_by, last_updated, updated_by)
          VALUES (?, ?, ?, ?, SYSUTCDATETIME(), ?)
        `,
        {
          replacements: [
            r.meter_id,
            r.reading_value,
            r.lastread_date,
            req.user.user_id,
            req.user.user_id,
          ],
        }
      );
    }

    res.json({ inserted: readings.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server error" });
  }
});

module.exports = router;