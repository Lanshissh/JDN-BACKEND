// models/Building.js
const { DataTypes } = require('sequelize');
const sequelize = require('./index');

const Building = sequelize.define('Building', {
  building_id:   { type: DataTypes.STRING, primaryKey: true },
  building_name: { type: DataTypes.STRING(30), allowNull: false },

  // Building-level base rates (now with min: 0 validations)
  erate_perKwH:  { 
    type: DataTypes.DECIMAL(10, 2), 
    allowNull: false, 
    defaultValue: 0.00,
    validate: { min: 0 }
  },
  emin_con:      { 
    type: DataTypes.DECIMAL(10, 2), 
    allowNull: false, 
    defaultValue: 0.00,
    validate: { min: 0 }
  },
  wrate_perCbM:  { 
    type: DataTypes.DECIMAL(10, 2), 
    allowNull: false, 
    defaultValue: 0.00,
    validate: { min: 0 }
  },
  wmin_con:      { 
    type: DataTypes.DECIMAL(10, 2), 
    allowNull: false, 
    defaultValue: 0.00,
    validate: { min: 0 }
  },
  lrate_perKg:   { 
    type: DataTypes.DECIMAL(10, 2), 
    allowNull: false, 
    defaultValue: 0.00,
    validate: { min: 0 }
  },

  markup_rate: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
    defaultValue: 0.00,
    validate: { min: 0 }
  },

  penalty_rate: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
    defaultValue: 0.00,
    validate: { min: 0 }
  },

  last_updated:  { type: DataTypes.DATE, allowNull: false },
  updated_by:    { type: DataTypes.STRING(30), allowNull: false },
  }, {
  tableName: 'building_list',
  timestamps: false,
});

module.exports = Building;
