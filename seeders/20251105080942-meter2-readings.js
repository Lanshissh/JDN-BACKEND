'use strict';

/**
 * Manual readings seeder for ONLY meter_id = 'MTR-1' (electric).
 * - Inserts daily values from 2024-11-21 to 2025-02-20 (inclusive).
 * - Idempotent: skips any (meter_id, lastread_date) that already exist.
 * - MSSQL-safe; continues MR-<n> numbering from current max.
 *
 * Run:
 *   npx sequelize-cli db:seed --seed seeders/<timestamp>-seed-readings-mtr1-manual.js
 */

const METER_ID = 'MTR-2';

const REMARKS = "test remarks"; // <-- used in inserted rows
const IMAGE   = "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";             // <-- used in inserted rows

// --- EDIT BELOW IF YOU WANT TO CHANGE NUMBERS/DATES -------------------------
const MANUAL_READINGS = {
  '2024-12-20':  16673.00,
  '2025-01-20':  16738.00,
  '2025-02-20':  16807.00,
  '2025-03-20':  16887.00,
  '2025-04-20':  16972.00,
  '2025-05-20':  17066.00,
};
// ---------------------------------------------------------------------------

function isYMD(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s));
}

module.exports = {
  up: async (queryInterface) => {
    // 1) Validate & normalize
    const entries = Object.entries(MANUAL_READINGS)
      .map(([date, val]) => ({ date: String(date), value: Number(val) }))
      .filter(({ date }) => isYMD(date));

    if (!entries.length) return;

    // 2) Ensure the meter exists (avoid FK issues)
    const [meters] = await queryInterface.sequelize.query(
      `SELECT meter_id FROM meter_list WHERE meter_id = :mid`,
      { replacements: { mid: METER_ID } }
    );
    if (!meters.length) return;

    // 3) Skip dates already present
    const dates = entries.map(e => e.date);
    const placeholders = dates.map((_, i) => `:d${i}`).join(',');
    const repl = Object.assign(
      { mid: METER_ID },
      Object.fromEntries(dates.map((d, i) => [`d${i}`, d]))
    );

    const [existing] = await queryInterface.sequelize.query(
      `
      SELECT CONVERT(varchar(10), lastread_date, 23) AS lastread_date
      FROM meter_reading
      WHERE meter_id = :mid AND lastread_date IN (${placeholders})
      `,
      { replacements: repl }
    );
    const existingSet = new Set(existing.map(r => r.lastread_date));

    const toInsert = entries
      .filter(e => !existingSet.has(e.date))
      .sort((a, b) => a.date.localeCompare(b.date));

    if (!toInsert.length) return;

    // 4) Find current max MR-<n>
    const [idRows] = await queryInterface.sequelize.query(
      `SELECT reading_id FROM meter_reading WHERE reading_id LIKE 'MR-%'`
    );
    let maxN = 0;
    for (const r of idRows) {
      const m = String(r.reading_id).match(/^MR-(\d+)$/);
      if (m) {
        const n = Number(m[1]);
        if (Number.isFinite(n) && n > maxN) maxN = n;
      }
    }

    // 5) Build rows (now includes remarks + image)
    const now = new Date().toISOString();
    const rows = toInsert.map(({ date, value }) => {
      maxN += 1;
      const v = Number(value);
      if (!Number.isFinite(v)) {
        throw new Error(`Invalid numeric value for ${date}: ${value}`);
      }
      return {
        reading_id:    `MR-${maxN}`,
        meter_id:      METER_ID,
        reading_value: Math.round(v * 100) / 100, // DECIMAL(30,2)
        lastread_date: date,
        read_by:       'System Admin',
        last_updated:  now,
        updated_by:    'System Admin',
        // NEW FIELDS:
        remarks:       REMARKS,
        image:         IMAGE
      };
    });

    // 6) Insert (chunked)
    const CHUNK = 1000;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK);
      await queryInterface.bulkInsert('meter_reading', slice, {});
    }
  },

  down: async (queryInterface) => {
    const dates = Object.keys(MANUAL_READINGS).filter(isYMD);
    if (!dates.length) return;

    await queryInterface.bulkDelete('meter_reading', {
      meter_id: METER_ID,
      lastread_date: { [queryInterface.sequelize.Op.in]: dates }
    }, {});
  }
};
