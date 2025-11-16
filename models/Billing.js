// models/Billing.js
const { DataTypes } = require('sequelize');
const sequelize = require('./index');

/**
 * One row = one building billing snapshot (with markup) for a specific period.
 *
 * It stores:
 * - building_id, building_name
 * - period_start, period_end
 * - totals (total_consumed_kwh, total_amount)
 * - penalty_rate_pct
 * - full JSON payload snapshot (payload_json) from the API output
 */
const Billing = sequelize.define(
  'Billing',
  {
    building_billing_id: {
      type: DataTypes.STRING(80),
      primaryKey: true,
    },

    building_id: {
      type: DataTypes.STRING(30),
      allowNull: false,
    },

    building_name: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },

    period_start: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },

    period_end: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },

    total_consumed_kwh: {
      type: DataTypes.DECIMAL(30, 4),
      allowNull: false,
      defaultValue: 0,
      validate: { min: 0 },
    },

    total_amount: {
      type: DataTypes.DECIMAL(14, 2),
      allowNull: false,
      defaultValue: 0,
      validate: { min: 0 },
    },

    penalty_rate_pct: {
      // e.g. 2.0 for "2%" in your request
      type: DataTypes.DECIMAL(10, 4),
      allowNull: false,
      defaultValue: 0,
      validate: { min: 0 },
    },

    // Raw JSON string; we add virtual getters/setters below
    payload_json: {
      type: DataTypes.TEXT,
      allowNull: true,
      get() {
        const raw = this.getDataValue('payload_json');
        if (!raw) return null;
        try {
          return JSON.parse(raw);
        } catch (e) {
          return null;
        }
      },
      set(val) {
        if (val === null || val === undefined) {
          this.setDataValue('payload_json', null);
        } else {
          this.setDataValue('payload_json', JSON.stringify(val));
        }
      },
    },

    generated_at: {
      type: DataTypes.DATE,
      allowNull: false,
    },

    last_updated: {
      type: DataTypes.DATE,
      allowNull: false,
    },

    updated_by: {
      type: DataTypes.STRING(30),
      allowNull: false,
    },
  },
  {
    tableName: 'billing_list',
    timestamps: false,
    indexes: [
      {
        name: 'ix_building_billing_building_period',
        unique: true,
        fields: ['building_id', 'period_start', 'period_end'],
      },
    ],
  }
);

module.exports = Billing;
