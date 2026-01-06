var createError = require("http-errors");
var express = require("express");
var path = require("path");
var cookieParser = require("cookie-parser");
var logger = require("morgan");
var cors = require("cors");

// Routers
var indexRouter = require("./routes/index");
var usersRouter = require("./routes/users");
var authRouter = require("./routes/auth");
var tenantsRouter = require("./routes/tenants");
var stallsRouter = require("./routes/stalls");
var meterRouter = require("./routes/meters");
var readingsRouter = require("./routes/readings");
var vatsRouter = require("./routes/vat");
var wtsRouter = require("./routes/wt");
var buildingsRouter = require("./routes/buildings");
var billingsRouter = require("./routes/billings");
var rocRouter = require("./routes/rateofchange");

// ✅ NEW/IMPORTANT routers
var readerRouter = require("./routes/readerDevices");
var offlineRouter = require("./routes/offlineExport");

// Sequelize setup
const sequelize = require("./models");
sequelize
  .authenticate()
  .then(() => console.log("Sequelize connected to MSSQL!"))
  .catch((err) => console.error("Unable to connect to DB via Sequelize:", err));

var app = express();

/**
 * ✅ CORS: allow your mobile/web apps to call the API
 * If you want to restrict origins later, replace origin: "*" with your domains.
 */
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Logging + parsers
app.use(logger("dev"));

// ✅ IMPORTANT: increase payload limit because offline export may include base64 images
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: false, limit: "25mb" }));

app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

// ✅ Health check (quick test)
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "billingsystem-api", time: new Date().toISOString() });
});

// Routes
app.use("/", indexRouter);
app.use("/users", usersRouter);
app.use("/auth", authRouter);
app.use("/tenants", tenantsRouter);
app.use("/stalls", stallsRouter);
app.use("/meters", meterRouter);
app.use("/readings", readingsRouter);
app.use("/vat", vatsRouter);
app.use("/wt", wtsRouter);
app.use("/buildings", buildingsRouter);
app.use("/billings", billingsRouter);
app.use("/roc", rocRouter);
app.use("/reader-devices", readerRouter);
app.use("/offlineExport", offlineRouter);

// catch 404 and forward to error handler
app.use(function (req, res, next) {
  next(createError(404));
});

// error handler
app.use(function (err, req, res, next) {
  res.status(err.status || 500).json({
    message: err.message,
    error: req.app.get("env") === "development" ? err : {},
  });
});

module.exports = app;