'use strict';

module.exports = {
  async up(qi, Sequelize) {
    await qi.createTable('building_list', {
      building_id:   { type: Sequelize.STRING(30), allowNull: false, primaryKey: true },
      building_name: { type: Sequelize.STRING(30), allowNull: false },

      // Building-level base rates (MSSQL-safe: removed .UNSIGNED)
      erate_perKwH:  { type: Sequelize.DECIMAL(10,2), allowNull: false, defaultValue: 0.00 },
      emin_con:      { type: Sequelize.DECIMAL(10,2), allowNull: false, defaultValue: 0.00 },
      wrate_perCbM:  { type: Sequelize.DECIMAL(10,2), allowNull: false, defaultValue: 0.00 },
      wmin_con:      { type: Sequelize.DECIMAL(10,2), allowNull: false, defaultValue: 0.00 },
      lrate_perKg:   { type: Sequelize.DECIMAL(10,2), allowNull: false, defaultValue: 0.00 },
      markup_rate:   { type: Sequelize.DECIMAL(10,2), allowNull: false, defaultValue: 0.00 },
      penalty_rate:  { type: Sequelize.DECIMAL(10,2), allowNull: false, defaultValue: 0.00 },

      last_updated:  { type: Sequelize.DATE, allowNull: false },
      updated_by:    { type: Sequelize.STRING(30), allowNull: false },
    });
  },

  async down(qi) {
    await qi.dropTable('building_list');
  }
};
