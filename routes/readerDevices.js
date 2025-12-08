const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const authenticateToken = require("../middleware/authenticateToken");
const authorizeRole = require("../middleware/authorizeRole");
const sequelize = require("../models");

// 1. Register device
router.post("/register", authenticateToken, async (req, res) => {
  try {
    const { device_name, device_info } = req.body;
    const user_id = req.user.user_id;

    if (!device_name) {
      return res.status(400).json({ error: "device_name is required" });
    }

    const device_token = crypto.randomBytes(24).toString("hex");

    await sequelize.query(
      `
        INSERT INTO reader_devices (user_id, device_name, device_info, device_token, status)
        VALUES (?, ?, ?, ?, 'active')
      `,
      {
        replacements: [user_id, device_name, device_info, device_token],
      }
    );

    res.json({ device_token, status: "active" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server error" });
  }
});

// 2. Admin list of all devices
router.get("/", authenticateToken, authorizeRole("admin"), async (req, res) => {
  try {
    const [rows] = await sequelize.query("SELECT * FROM reader_devices");
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server error" });
  }
});

// 3. Block / unblock device
router.patch(
  "/:device_id/status",
  authenticateToken,
  authorizeRole("admin"),
  async (req, res) => {
    try {
      const { status } = req.body;
      const { device_id } = req.params;

      if (!["active", "blocked"].includes(status)) {
        return res.status(400).json({ error: "invalid status" });
      }

      // Update status
      await sequelize.query(
        "UPDATE reader_devices SET status = ? WHERE device_id = ?",
        { replacements: [status, device_id] }
      );

      // Return the full updated row so the frontend can update its state
      const [rows] = await sequelize.query(
        "SELECT * FROM reader_devices WHERE device_id = ?",
        { replacements: [device_id] }
      );

      if (!rows || rows.length === 0) {
        return res.status(404).json({ error: "Device not found" });
      }

      return res.json(rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "server error" });
    }
  }
);

// 4. DELETE device
router.delete(
  "/:device_id",
  authenticateToken,
  authorizeRole("admin"),
  async (req, res) => {
    try {
      const { device_id } = req.params;

      // Check existence
      const [rows] = await sequelize.query(
        "SELECT * FROM reader_devices WHERE device_id = ?",
        { replacements: [device_id] }
      );
      if (!rows || rows.length === 0) {
        return res.status(404).json({ error: "Device not found" });
      }

      // Delete
      await sequelize.query(
        "DELETE FROM reader_devices WHERE device_id = ?",
        { replacements: [device_id] }
      );

      return res.json({ success: true, deleted_id: device_id });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "server error" });
    }
  }
);

module.exports = router;