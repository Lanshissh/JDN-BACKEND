'use strict';

/**
 * Seeds: building_list
 * - MSSQL-friendly
 * - Idempotent: skips rows that already exist by building_id
 */

module.exports = {
  async up (queryInterface) {
    const seedBuildings = [
      {
        building_id: 'BLDG-1',
        building_name: 'Nepo Mall Alaminos',
        erate_perKwH: 10.00,
        emin_con: 1.00,
        wrate_perCbM: 93.00,       // keep numeric, not string
        wmin_con: 3.00,
        lrate_perKg: 88.00,
        markup_rate: 1.5,
        penalty_rate: 0.2,
        last_updated: new Date(),
        updated_by: 'System Admin',
      },
      {
        building_id: 'BLDG-2',
        building_name: 'Nepo Mall Angeles',
        erate_perKwH: 10.00,
        emin_con: 1.00,
        wrate_perCbM: 93.00,
        wmin_con: 3.00,
        lrate_perKg: 88.00,
        markup_rate: 1.5,
        penalty_rate: 0.2,
        last_updated: new Date(),
        updated_by: 'System Admin',
      }
    ];

    if (!seedBuildings.length) return;

    // Check which IDs already exist (safe for MSSQL)
    const idsSql = seedBuildings
      .map(b => `'${String(b.building_id).replace(/'/g, "''")}'`)
      .join(',');

    const [existingRows] = await queryInterface.sequelize.query(
      `SELECT building_id FROM building_list WHERE building_id IN (${idsSql})`
    );
    const existing = new Set((existingRows || []).map(r => r.building_id));

    const rowsToInsert = seedBuildings.filter(b => !existing.has(b.building_id));
    if (!rowsToInsert.length) return;

    await queryInterface.bulkInsert('building_list', rowsToInsert, {});
  },

  async down (queryInterface) {
    await queryInterface.bulkDelete('building_list', {
      building_id: ['BLDG-1', 'BLDG-2']
    }, {});
  }
};
