var createError = require('http-errors');
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
var cors = require('cors');

// Routers
var indexRouter = require('./routes/index');
var usersRouter = require('./routes/users');
var authRouter = require('./routes/auth');
var tenantsRouter = require('./routes/tenants');
var stallsRouter = require('./routes/stalls');
var meterRouter = require('./routes/meters');
var readingsRouter = require('./routes/readings');
var vatsRouter = require('./routes/vat');
var wtsRouter = require('./routes/wt');
var buildingsRouter = require('./routes/buildings');
var billingsRouter = require('./routes/billings');
var rocRouter = require('./routes/rateofchange');
var rDevicesRouter = require('./routes/readerDevices');
var offlineExportRouter = require('./routes/offlineExport');

// Sequelize setup
const sequelize = require('./models');
sequelize
  .authenticate()
  .then(() => console.log('Sequelize connected to MSSQL!'))
  .catch((err) => console.error('Unable to connect to DB via Sequelize:', err));

var app = express();

app.use(cors());
app.use(logger('dev'));

// (optional but recommended) allow larger image payloads from offline export
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: false, limit: '50mb' }));

app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/', indexRouter);
app.use('/users', usersRouter);
app.use('/auth', authRouter);
app.use('/tenants', tenantsRouter);
app.use('/stalls', stallsRouter);
app.use('/meters', meterRouter);
app.use('/readings', readingsRouter);
app.use('/meter_reading', readingsRouter);
app.use('/vat', vatsRouter);
app.use('/wt', wtsRouter);
app.use('/buildings', buildingsRouter);
app.use('/billings', billingsRouter);
app.use('/roc', rocRouter);

// ✅ FIX: mount Reader Devices where your frontend expects it
app.use('/reader-devices', rDevicesRouter);

// ✅ keep old path as alias (so older builds won't break)
app.use('/readerDevices', rDevicesRouter);

app.use('/offlineExport', offlineExportRouter);

// catch 404 and forward to error handler
app.use(function (req, res, next) {
  next(createError(404));
});

// error handler
app.use(function (err, req, res, next) {
  res.status(err.status || 500).json({
    message: err.message,
    error: req.app.get('env') === 'development' ? err : {},
  });
});

module.exports = app;