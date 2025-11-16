'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('billing_list', {
      // 1 row = 1 building + 1 period
      building_billing_id: {
        // e.g. "BLDG-1-2025-01-21-2025-02-20"
        type: Sequelize.STRING(80),
        allowNull: false,
        primaryKey: true,
      },

      building_id: {
        type: Sequelize.STRING(30),
        allowNull: false,
      },

      building_name: {
        type: Sequelize.STRING(100),
        allowNull: true,
      },

      period_start: {
        type: Sequelize.DATEONLY,
        allowNull: false,
      },

      period_end: {
        type: Sequelize.DATEONLY,
        allowNull: false,
      },

      // Totals for the building (from "totals" in your output)
      total_consumed_kwh: {
        type: Sequelize.DECIMAL(30, 4),
        allowNull: false,
        defaultValue: 0,
      },

      total_amount: {
        type: Sequelize.DECIMAL(14, 2),
        allowNull: false,
        defaultValue: 0,
      },

      // penalty_rate query param used for this generation (e.g. 2 for 2%)
      penalty_rate_pct: {
        type: Sequelize.DECIMAL(10, 4),
        allowNull: false,
        defaultValue: 0,
      },

      /**
       * Full JSON payload snapshot of the building billing:
       * {
       *   building_id,
       *   period: { start, end },
       *   tenants: [...],
       *   totals: {...},
       *   generated_at: "...",
       * }
       */
      payload_json: {
        type: Sequelize.TEXT, // store JSON string, works on all dialects
        allowNull: true,
      },

      generated_at: {
        type: Sequelize.DATE,
        allowNull: false,
      },

      last_updated: {
        type: Sequelize.DATE,
        allowNull: false,
      },

      updated_by: {
        type: Sequelize.STRING(30),
        allowNull: false,
      },
    });

    // enforce uniqueness per building+period
    await queryInterface.addIndex('billing_list', {
      name: 'ix_building_billing_building_period',
      unique: true,
      fields: ['building_id', 'period_start', 'period_end'],
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeIndex(
      'billing_list',
      'ix_building_billing_building_period'
    );

    await queryInterface.dropTable('billing_list');
  }
};
