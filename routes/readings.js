const express = require('express');
const router = express.Router();

const { Op } = require('sequelize');

// Utilities & middleware
const getCurrentDateTime = require('../utils/getCurrentDateTime');
const authenticateToken = require('../middleware/authenticateToken');
const authorizeRole = require('../middleware/authorizeRole');

// Models
const Reading = require('../models/Reading');
const Meter   = require('../models/Meter');
const Stall   = require('../models/Stall');

// ---------------------------------------------------------------------------
// If you expect image uploads via JSON, consider bumping the parser limits here.
// router.use(express.json({ limit: '10mb' }));
// router.use(express.urlencoded({ limit: '10mb', extended: true }));

// Auth guard for all routes
router.use(authenticateToken);

// ---------------------------------------------------------------------------
// Helpers

// Accept roles from user_level or user_roles; supports array, CSV string, or object forms.
function isAdmin(req) {
  const src = (req.user && (req.user.user_level ?? req.user.user_roles)) ?? null;
  if (!src) return false;

  const toList = (v) => {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') {
      try { const parsed = JSON.parse(v); if (Array.isArray(parsed)) return parsed; } catch {}
      return v.split(',').map(s => s.trim()).filter(Boolean);
    }
    if (typeof v === 'object' && v !== null) {
      const maybe = (v.role || v.name || v.type || '').toString();
      return maybe ? [maybe] : [];
    }
    return [String(v)];
  };

  const roles = toList(src).map(r => String(r).toLowerCase().trim());
  return roles.includes('admin');
}

function todayYMD() {
  return new Date().toISOString().slice(0, 10);
}

function coerceReadingValue(val) {
  if (val === '' || val == null) return { ok: false, error: 'reading_value is required and must be a number' };
  const num = Number(val);
  if (!Number.isFinite(num) || num < 0) return { ok: false, error: 'reading_value must be a non-negative number' };
  return { ok: true, value: Math.round(num * 100) / 100 }; // match DECIMAL(30,2)
}

// Convert inbound image payloads to a Buffer (supports hex, base64, base64url, data URLs, or Buffer)
function toImageBuffer(input) {
  if (input == null || input === '') return null;
  if (Buffer.isBuffer(input)) return input;

  const s = String(input).trim();

  // data URL -> base64
  if (s.startsWith('data:')) {
    const base64 = s.split(',')[1] || '';
    return Buffer.from(base64, 'base64');
  }

  // base64url -> base64
  if (/^[A-Za-z0-9\-_]+=*$/.test(s) && (s.includes('-') || s.includes('_'))) {
    let t = s.replace(/-/g, '+').replace(/_/g, '/');
    while (t.length % 4) t += '=';
    try { return Buffer.from(t, 'base64'); } catch {}
  }

  // base64 heuristic
  if (/^[A-Za-z0-9+/=\r\n]+$/.test(s) && (s.length % 4 === 0)) {
    try { return Buffer.from(s, 'base64'); } catch {}
  }

  // hex (pairs)
  if (/^([0-9a-fA-F]{2})+$/.test(s)) {
    return Buffer.from(s, 'hex');
  }

  throw new Error('image must be hex, base64, base64url, or data URL base64');
}

// Resolve building_id for the current user.
// We only have building_ids array in the JWT payload (see auth.js),
// so pick the first one as the primary building. If none, return null.
function getUserBuildingId(req) {
  if (!req || !req.user) return null;

  // If a direct building_id was ever added later, prefer that.
  if (req.user.building_id) return req.user.building_id;

  const ids = Array.isArray(req.user.building_ids) ? req.user.building_ids : [];
  return ids.length > 0 ? ids[0] : null;
}

// Resolve building_id for a meter
async function getMeterBuildingId(meterId) {
  const meter = await Meter.findOne({ where: { meter_id: meterId }, attributes: ['stall_id', 'building_id'], raw: true });
  if (!meter) return null;

  if (meter.building_id) return meter.building_id; // prefer direct if present

  if (meter.stall_id) {
    const stall = await Stall.findOne({ where: { stall_id: meter.stall_id }, attributes: ['building_id'], raw: true });
    return stall?.building_id || null;
  }
  return null;
}

// Resolve building_id for a reading
async function getReadingBuildingId(readingId) {
  const reading = await Reading.findOne({ where: { reading_id: readingId }, attributes: ['meter_id'], raw: true });
  if (!reading) return null;
  return getMeterBuildingId(reading.meter_id);
}

// Generate a new reading_id (MR-<n>) by scanning existing
async function generateReadingId() {
  const rows = await Reading.findAll({
    where: { reading_id: { [Op.like]: 'MR-%' } },
    attributes: ['reading_id'],
    raw: true
  });
  const maxNum = rows.reduce((max, r) => {
    const m = String(r.reading_id).match(/^MR-(\d+)$/);
    return m ? Math.max(max, Number(m[1])) : max;
  }, 0);
  return `MR-${maxNum + 1}`;
}

// ---------------------------------------------------------------------------
// Routes

/**
 * GET /meter_reading
 * Admin: all readings (no building checks, even if building_id is null)
 * Non-admin: readings under their assigned building
 */
router.get('/',
  authorizeRole('admin', 'operator', 'biller', 'reader'),
  async (req, res) => {
    try {
      if (isAdmin(req)) {
        const readings = await Reading.findAll({ order: [['lastread_date', 'DESC'], ['reading_id', 'DESC']] });
        return res.json(readings);
      }

      const buildingId = getUserBuildingId(req);
      if (!buildingId) {
        return res.status(401).json({ error: 'Unauthorized: No building assigned' });
      }

      const stalls = await Stall.findAll({ where: { building_id: buildingId }, attributes: ['stall_id'], raw: true });
      const stallIds = stalls.map(s => s.stall_id);
      if (!stallIds.length) return res.json([]);

      const meters = await Meter.findAll({ where: { stall_id: stallIds }, attributes: ['meter_id'], raw: true });
      const meterIds = meters.map(m => m.meter_id);
      if (!meterIds.length) return res.json([]);

      const readings = await Reading.findAll({
        where: { meter_id: meterIds },
        order: [['lastread_date', 'DESC'], ['reading_id', 'DESC']]
      });

      return res.json(readings);
    } catch (err) {
      console.error('Database error:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * GET /meter_reading/:id
 * Admin: always allowed
 * Non-admin: only if reading is under their building
 */
router.get('/:id',
  authorizeRole('admin', 'operator', 'biller', 'reader'),
  async (req, res) => {
    try {
      const readingId = req.params.id;

      const reading = await Reading.findOne({ where: { reading_id: readingId } });
      if (!reading) return res.status(404).json({ message: 'Meter reading not found' });

      if (isAdmin(req)) {
        return res.json(reading);
      }

      const buildingId = getUserBuildingId(req);
      if (!buildingId) return res.status(401).json({ error: 'Unauthorized: No building assigned' });

      const recordBuildingId = await getReadingBuildingId(readingId);
      if (recordBuildingId && recordBuildingId !== buildingId) {
        return res.status(403).json({ error: 'No access: This meter reading is not under your assigned building.' });
      }

      res.json(reading);
    } catch (err) {
      console.error('Database error:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * GET /meter_reading/:id/image
 * Streams the stored image bytes; admin bypasses building checks
 * Supports images stored as Buffer **or** base64/dataURL/hex text.
 */
router.get('/:id/image',
  authorizeRole('admin', 'operator', 'biller', 'reader'),
  async (req, res) => {
    try {
      const readingId = req.params.id;
      const reading = await Reading.findOne({ where: { reading_id: readingId } });

      if (!reading) return res.status(404).json({ error: 'Reading not found' });
      if (!reading.image) return res.status(404).json({ error: 'No image for this reading' });

      // Building access check for non-admin
      if (!isAdmin(req)) {
        const buildingId = getUserBuildingId(req);
        if (!buildingId) return res.status(401).json({ error: 'Unauthorized: No building assigned' });

        const recordBuildingId = await getReadingBuildingId(readingId);
        if (recordBuildingId && recordBuildingId !== buildingId) {
          return res.status(403).json({ error: 'No access: This meter reading is not under your assigned building.' });
        }
      }

      // 🔑 Normalize whatever is stored (Buffer, base64, data URL, hex) into real bytes
      let imageBuf;
      try {
        imageBuf = toImageBuffer(reading.image);
        if (!imageBuf || !imageBuf.length) {
          return res.status(404).json({ error: 'Stored image is empty or invalid' });
        }
      } catch (e) {
        console.error('Error decoding stored image:', e);
        return res.status(500).json({ error: 'Failed to decode stored image data' });
      }

      // Default to JPEG; adjust if you later store mime type separately
      res.setHeader('Content-Type', 'image/jpeg');
      res.send(imageBuf);
    } catch (err) {
      console.error('Error in GET /meter_reading/:id/image:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * GET /meter_reading/by-date/:date (YYYY-MM-DD)
 * Admin: all meters; Non-admin: only their building
 */
router.get('/by-date/:date',
  authorizeRole('admin', 'operator', 'biller', 'reader'),
  async (req, res) => {
    const date = req.params.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
    }

    try {
      if (isAdmin(req)) {
        const rows = await Reading.findAll({ where: { lastread_date: date }, order: [['reading_id', 'ASC']] });
        return res.json(rows);
      }

      const buildingId = getUserBuildingId(req);
      if (!buildingId) return res.status(401).json({ error: 'Unauthorized: No building assigned' });

      const stalls = await Stall.findAll({ where: { building_id: buildingId }, attributes: ['stall_id'], raw: true });
      const stallIds = stalls.map(s => s.stall_id);
      if (!stallIds.length) return res.json([]);

      const meters = await Meter.findAll({ where: { stall_id: stallIds }, attributes: ['meter_id'], raw: true });
      const meterIds = meters.map(m => m.meter_id);
      if (!meterIds.length) return res.json([]);

      const rows = await Reading.findAll({
        where: { meter_id: meterIds, lastread_date: date },
        order: [['reading_id', 'ASC']]
      });
      return res.json(rows);
    } catch (err) {
      console.error('by-date error:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * GET /meter_reading/today
 * Admin: all meters; Non-admin: only their building
 */
router.get('/today',
  authorizeRole('admin', 'operator', 'biller', 'reader'),
  async (req, res) => {
    const date = todayYMD();
    try {
      if (isAdmin(req)) {
        const rows = await Reading.findAll({ where: { lastread_date: date }, order: [['reading_id', 'ASC']] });
        return res.json(rows);
      }

      const buildingId = getUserBuildingId(req);
      if (!buildingId) return res.status(401).json({ error: 'Unauthorized: No building assigned' });

      const stalls = await Stall.findAll({ where: { building_id: buildingId }, attributes: ['stall_id'], raw: true });
      const stallIds = stalls.map(s => s.stall_id);
      if (!stallIds.length) return res.json([]);

      const meters = await Meter.findAll({ where: { stall_id: stallIds }, attributes: ['meter_id'], raw: true });
      const meterIds = meters.map(m => m.meter_id);
      if (!meterIds.length) return res.json([]);

      const rows = await Reading.findAll({
        where: { meter_id: meterIds, lastread_date: date },
        order: [['reading_id', 'ASC']]
      });
      return res.json(rows);
    } catch (err) {
      console.error('today error:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * GET /meter_reading/by-meter/:meter_id
 * Admin: any meter; Non-admin: only meters under their building
 * Optional query: ?from=YYYY-MM-DD&to=YYYY-MM-DD&order=ASC|DESC&limit=50&offset=0
 */
router.get('/by-meter/:meter_id',
  authorizeRole('admin', 'operator', 'biller', 'reader'),
  async (req, res) => {
    const meterId = req.params.meter_id;
    const { from, to, order = 'DESC', limit, offset } = req.query || {};

    try {
      const meter = await Meter.findOne({ where: { meter_id: meterId }, attributes: ['stall_id', 'building_id'], raw: true });
      if (!meter) return res.status(404).json({ error: 'Meter not found' });

      if (!isAdmin(req)) {
        const userBldg = getUserBuildingId(req);
        if (!userBldg) return res.status(401).json({ error: 'Unauthorized: No building assigned' });
        const meterBldg = await getMeterBuildingId(meterId);
        if (!meterBldg || meterBldg !== userBldg) {
          return res.status(403).json({ error: 'No access: Meter not under your assigned building.' });
        }
      }

      const where = { meter_id: meterId };
      if (from || to) {
        const isYMD = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d));
        if ((from && !isYMD(from)) || (to && !isYMD(to))) {
          return res.status(400).json({ error: 'Invalid from/to format. Use YYYY-MM-DD.' });
        }
        if (from && to)       where.lastread_date = { [Op.between]: [from, to] };
        else if (from)        where.lastread_date = { [Op.gte]: from };
        else if (to)          where.lastread_date = { [Op.lte]: to };
      }

      const ord = (String(order).toUpperCase() === 'ASC') ? 'ASC' : 'DESC';
      const findOpts = {
        where,
        order: [['lastread_date', ord], ['reading_id', 'ASC']],
      };
      if (limit !== undefined)  findOpts.limit  = Math.max(0, Number(limit) || 0);
      if (offset !== undefined) findOpts.offset = Math.max(0, Number(offset) || 0);

      const rows = await Reading.findAll(findOpts);
      return res.json(rows);
    } catch (err) {
      console.error('Error in GET /meter_reading/by-meter/:meter_id:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * POST /meter_reading
 * Create a new reading (one per meter per date).
 * Admin: any meter; Non-admin: only meters under their building.
 * REQUIRED: image (base64/base64url/data URL/hex/Buffer). remarks optional.
 */
router.post('/',
  authorizeRole('admin', 'operator', 'reader'),
  async (req, res) => {
    let { meter_id, reading_value, lastread_date, remarks, image } = req.body || {};

    // Required fields
    if (!meter_id || reading_value === undefined) {
      return res.status(400).json({ error: 'meter_id and reading_value are required' });
    }
    // IMAGE IS REQUIRED
    if (image === undefined || image === null || image === '') {
      return res.status(400).json({ error: 'image is required (send base64, base64url, data URL, hex, or Buffer)' });
    }

    // Coerce & decode
    const coerced = coerceReadingValue(reading_value);
    if (!coerced.ok) return res.status(400).json({ error: coerced.error });
    reading_value = coerced.value;

    let imageBuf;
    try {
      imageBuf = toImageBuffer(image);
      if (!imageBuf || imageBuf.length === 0) {
        return res.status(400).json({ error: 'image cannot be empty' });
      }
    } catch (e) {
      return res.status(400).json({ error: e.message || 'invalid image encoding' });
    }

    try {
      const meter = await Meter.findOne({ where: { meter_id } });
      if (!meter) return res.status(404).json({ error: 'Meter not found' });

      if (!isAdmin(req)) {
        const userBldg = getUserBuildingId(req);
        if (!userBldg) return res.status(401).json({ error: 'Unauthorized: No building assigned' });
        const meterBldg = await getMeterBuildingId(meter_id);
        if (!meterBldg || meterBldg !== userBldg) {
          return res.status(403).json({ error: 'No access: You can only create readings for meters under your assigned building.' });
        }
      }

      const dateOnly = (lastread_date && /^\d{4}-\d{2}-\d{2}$/.test(lastread_date))
        ? lastread_date
        : todayYMD();

      // Enforce one reading per meter per date
      const existing = await Reading.findOne({
        where: { meter_id, lastread_date: dateOnly },
        attributes: ['reading_id'],
        raw: true
      });
      if (existing) {
        return res.status(409).json({ error: `Reading already exists for ${meter_id} on ${dateOnly}` });
      }

      const newReadingId = await generateReadingId();
      const now = getCurrentDateTime();
      const updatedBy = req.user?.user_fullname || 'System';

      const payload = {
        reading_id:   newReadingId,
        meter_id,
        reading_value,
        lastread_date: dateOnly,
        read_by:      updatedBy,
        last_updated: now,
        updated_by:   updatedBy,
        remarks:      (remarks ?? null),
        image:        imageBuf 
      };

      await Reading.create(payload);
      res.status(201).json({ message: 'Reading created successfully', readingId: newReadingId });
    } catch (err) {
      console.error('Error in POST /meter_reading:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * PUT /meter_reading/:id
 * Update an existing reading (partial allowed).
 * Admin: any; Non-admin: only under their building.
 * If 'image' is included, it must be valid and non-empty (cannot be cleared).
 * remarks is optional; send null to clear remarks.
 */
router.put('/:id',
  authorizeRole('admin', 'operator', 'reader'),
  async (req, res) => {
    const readingId = req.params.id;
    let { meter_id, reading_value, lastread_date, remarks, image } = req.body || {};
    const updatedBy = req.user?.user_fullname || 'System';
    const now = getCurrentDateTime();

    try {
      const reading = await Reading.findOne({ where: { reading_id: readingId } });
      if (!reading) return res.status(404).json({ error: 'Reading not found' });

      if (!isAdmin(req)) {
        const userBldg = getUserBuildingId(req);
        if (!userBldg) return res.status(401).json({ error: 'Unauthorized: No building assigned' });

        const currentBldg = await getReadingBuildingId(readingId);
        if (!currentBldg || currentBldg !== userBldg) {
          return res.status(403).json({ error: 'No access: You can only update readings under your assigned building.' });
        }

        if (meter_id && meter_id !== reading.meter_id) {
          const newMeterExists = await Meter.findOne({ where: { meter_id } });
          if (!newMeterExists) return res.status(400).json({ error: 'Invalid meter_id: Meter does not exist.' });
          const newMeterBldg = await getMeterBuildingId(meter_id);
          if (!newMeterBldg || newMeterBldg !== userBldg) {
            return res.status(403).json({ error: 'No access: The new meter is not under your assigned building.' });
          }
        }
      }

      if (
        meter_id === undefined &&
        reading_value === undefined &&
        lastread_date === undefined &&
        remarks === undefined &&
        image === undefined
      ) {
        return res.status(400).json({ message: 'No changes detected in the request body.' });
      }

      if (lastread_date !== undefined) {
        const dateOnly = lastread_date
          ? (/^\d{4}-\d{2}-\d{2}$/.test(String(lastread_date)) ? lastread_date : null)
          : todayYMD();

        if (!dateOnly) {
          return res.status(400).json({ error: 'Invalid lastread_date format. Use YYYY-MM-DD.' });
        }

        const targetMeterId = meter_id || reading.meter_id;
        const clash = await Reading.findOne({
          where: {
            meter_id: targetMeterId,
            lastread_date: dateOnly,
            reading_id: { [Op.ne]: readingId }
          },
          attributes: ['reading_id'],
          raw: true
        });
        if (clash) {
          return res.status(409).json({ error: `Reading already exists for ${targetMeterId} on ${dateOnly}` });
        }

        reading.lastread_date = dateOnly;
      }

      if (meter_id) reading.meter_id = meter_id;

      if (reading_value !== undefined) {
        const coerced = coerceReadingValue(reading_value);
        if (!coerced.ok) return res.status(400).json({ error: coerced.error });
        reading.reading_value = coerced.value;
      }

      // remarks is optional; allow null to clear
      if (remarks !== undefined) {
        reading.remarks = (remarks ?? null);
      }

      // image is REQUIRED in DB; do NOT allow clearing to null/emptys
      if (image !== undefined) {
        if (image === null || image === '') {
          return res.status(400).json({ error: 'image is required; do not send null/empty to clear it' });
        }
        try {
          const buf = toImageBuffer(image);
          if (!buf || buf.length === 0) {
            return res.status(400).json({ error: 'image cannot be empty' });
          }
          reading.image = buf;
        } catch (e) {
          return res.status(400).json({ error: e.message || 'invalid image encoding' });
        }
      }

      reading.read_by = updatedBy;
      reading.last_updated = now;
      reading.updated_by = updatedBy;

      await reading.save();
      res.json({ message: `Reading with ID ${readingId} updated successfully` });
    } catch (err) {
      console.error('Error in PUT /meter_reading/:id:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * DELETE /meter_reading/:id
 * Admin: any; Non-admin: only under their building.
 */
router.delete('/:id',
  authorizeRole('admin', 'operator', 'reader'),
  async (req, res) => {
    const readingId = req.params.id;
    if (!readingId) {
      return res.status(400).json({ error: 'Reading ID is required' });
    }
    try {
      const reading = await Reading.findOne({ where: { reading_id: readingId } });
      if (!reading) {
        return res.status(404).json({ error: 'Reading not found' });
      }

      if (!isAdmin(req)) {
        const userBldg = getUserBuildingId(req);
        if (!userBldg) {
          return res.status(401).json({ error: 'Unauthorized: No building assigned' });
        }
        const readingBldg = await getReadingBuildingId(readingId);
        if (!readingBldg || readingBldg !== userBldg) {
          return res.status(403).json({
            error: 'No access: You can only delete readings under your assigned building.'
          });
        }
      }

      const deleted = await Reading.destroy({ where: { reading_id: readingId } });
      if (deleted === 0) {
        return res.status(404).json({ error: 'Reading not found' });
      }
      res.json({ message: `Reading with ID ${readingId} deleted successfully` });
    } catch (err) {
      console.error('Error in DELETE /meter_reading/:id:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;