// models/User.js
const { DataTypes } = require('sequelize');
const sequelize = require('./index');

// ---- helpers ----
// Normalize to array for JSON storage
function toArray(v) {
  if (Array.isArray(v)) return v;

  if (v == null) return [];

  // If already a JSON string like '["a","b"]'
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return [];
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) return parsed;
    } catch {}

    // Fallback: comma-separated
    return s.split(',').map(x => x.trim()).filter(Boolean);
  }

  return [v];
}

function jsonGet(self, key) {
  try {
    const raw = self.getDataValue(key);
    if (raw == null || raw === '') return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function jsonSet(self, key, value) {
  self.setDataValue(key, JSON.stringify(toArray(value)));
}

const User = sequelize.define('User', {
  user_id: {
    type: DataTypes.STRING(30),
    primaryKey: true,
    allowNull: false
  },

  user_password: {
    type: DataTypes.STRING(255),
    allowNull: false
  },

  user_fullname: {
    type: DataTypes.STRING(50),
    allowNull: false
  },

  // e.g., ["electric","water"]
  utility_role: {
    type: DataTypes.TEXT, // MSSQL -> NVARCHAR(MAX)
    allowNull: false,
    defaultValue: '[]',
    get() { return jsonGet(this, 'utility_role'); },
    set(v) { jsonSet(this, 'utility_role', v); }
  },

  // multi-role, e.g., ["admin","biller","reader"]
  user_roles: {
    type: DataTypes.TEXT,
    allowNull: false,
    defaultValue: '[]',
    get() { return jsonGet(this, 'user_roles'); },
    set(v) { jsonSet(this, 'user_roles', v); }
  },

  // multi-building, e.g., ["BLDG-1","BLDG-3"]
  building_ids: {
    type: DataTypes.TEXT,
    allowNull: false,
    defaultValue: '[]',
    get() { return jsonGet(this, 'building_ids'); },
    set(v) { jsonSet(this, 'building_ids', v); }
  },

  // ✅ NEW: access modules, e.g., ["meters","buildings"]
  access_modules: {
    type: DataTypes.TEXT,
    allowNull: false,
    defaultValue: '[]',
    get() { return jsonGet(this, 'access_modules'); },
    set(v) { jsonSet(this, 'access_modules', v); }
  },
}, {
  tableName: 'user_accounts',
  timestamps: false
});

module.exports = User;