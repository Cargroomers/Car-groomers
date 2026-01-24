require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const app = express();

// ✅ Render provides PORT automatically
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || "default_secret";

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Admin@123";

// ✅ REQUIRED for Render Postgres (SSL support)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false
});

// ✅ Middleware
app.set("trust proxy", 1);
app.use(express.json());

const ALLOWED_ORIGINS = [
  "https://cargroomers.netlify.app",
  "https://www.cargroomers.netlify.app",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:5500",
  "http://127.0.0.1:5500"
];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);

      if (ALLOWED_ORIGINS.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error("CORS blocked: " + origin + " not allowed"), false);
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true
  })
);

app.options("*", cors());

// ✅ Serve frontend from /public folder
app.use(express.static(path.join(__dirname, "public")));

/* =====================================
   ✅ Helper Functions
===================================== */

// ✅ REQUIRED CHANGE: Clean phone like "94637 33229" => "9463733229"
function cleanPhone(phone) {
  return String(phone || "").replace(/[^\d]/g, "");
}

// ✅ REQUIRED CHANGE: Only 10 digits (after cleaning)
function isValidPhone(phone) {
  const cleaned = cleanPhone(phone);
  return /^[0-9]{10}$/.test(cleaned);
}

function isValidService(service) {
  const allowed = [
    "PPF",
    "Ceramic Coating",
    "Window Tint",
    "Full Detailing",
    "Interior Cleaning",
    "Exterior Wash",
    "Custom Combo Plan"
  ];
  return allowed.includes(service);
}

// ✅ REQUIRED CHANGE: Date must be today -> next 1 year
function isValidBookingDate(dateStr) {
  // expects YYYY-MM-DD
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ""))) return false;

  const bookingDate = new Date(dateStr + "T00:00:00");
  if (isNaN(bookingDate.getTime())) return false;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const oneYearLater = new Date(today);
  oneYearLater.setFullYear(oneYearLater.getFullYear() + 1);

  // ✅ allow today to <= 1 year later
  return bookingDate >= today && bookingDate <= oneYearLater;
}

function requireAdminAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Missing admin token" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.admin = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

/* =====================================
   ✅ API: Health Check
===================================== */

app.get("/api/health", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW() AS server_time");
    res.json({
      ok: true,
      message: "Server is running",
      db_time: result.rows[0].server_time
    });
  } catch (err) {
    console.error("DB ERROR:", err);
    res.status(500).json({ ok: false, error: "Database connection failed" });
  }
});

/* =====================================
   ✅ API: Booking
===================================== */

// ✅ Create Booking (multi service + date validation + phone cleaning)
app.post("/api/book", async (req, res) => {
  try {
    let { name, phone, service, date, time, note } = req.body;

    if (!name || !phone || !service || !date || !time) {
      return res.status(400).json({ error: "All fields are required" });
    }

    const cleanedPhone = cleanPhone(phone);

    if (!isValidPhone(cleanedPhone)) {
      return res.status(400).json({
        error: "Phone number must be exactly 10 digits (spaces / + / - allowed)."
      });
    }

    // ✅ REQUIRED CHANGE: service can be string or array
    let serviceText = "";
    if (Array.isArray(service)) {
      // validate all
      for (const s of service) {
        if (!isValidService(s)) {
          return res.status(400).json({
            error:
              "Invalid service selected: " +
              s +
              ". Allowed: PPF, Ceramic Coating, Window Tint, Full Detailing, Interior Cleaning, Exterior Wash, Custom Combo Plan"
          });
        }
      }
      serviceText = service.join(", ");
    } else {
      if (!isValidService(service)) {
        return res.status(400).json({
          error:
            "Invalid service. Allowed: PPF, Ceramic Coating, Window Tint, Full Detailing, Interior Cleaning, Exterior Wash, Custom Combo Plan"
        });
      }
      serviceText = String(service);
    }

    // ✅ REQUIRED CHANGE: validate date (today -> 1 year)
    if (!isValidBookingDate(date)) {
      return res.status(400).json({
        error: "Preferred date must be between today and next 1 year."
      });
    }

    const insertQuery = `
      INSERT INTO bookings (name, phone, service, date, time, note, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'pending')
      RETURNING id
    `;

    const result = await pool.query(insertQuery, [
      String(name).trim(),
      cleanedPhone.trim(),
      serviceText.trim(),
      date,
      String(time).trim(),
      note ? String(note).trim() : ""
    ]);

    res.json({
      success: true,
      message: "Booking request submitted successfully!",
      bookingId: result.rows[0].id
    });
  } catch (err) {
    console.error("BOOKING ERROR:", err);
    res.status(500).json({ error: "Server error creating booking" });
  }
});

// ✅ Check booking status
app.get("/api/booking/:id", async (req, res) => {
  try {
    const bookingId = parseInt(req.params.id);

    if (!bookingId) {
      return res.status(400).json({ error: "Invalid booking ID" });
    }

    const result = await pool.query(
      `SELECT 
        id, service, date, time, status, created_at,
        suggested_date, suggested_time,
        confirmed_date, confirmed_time,
        note, name, phone
      FROM bookings 
      WHERE id = $1`,
      [bookingId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Booking not found" });
    }

    res.json({ booking: result.rows[0] });
  } catch (err) {
    console.error("BOOKING STATUS ERROR:", err);
    res.status(500).json({ error: "Server error fetching booking status" });
  }
});

/* =====================================
   ✅ API: Admin Authentication
===================================== */

app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body || {};

  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Invalid admin credentials" });
  }

  const token = jwt.sign(
    { role: "admin", username: ADMIN_USERNAME },
    JWT_SECRET,
    { expiresIn: "2h" }
  );

  return res.json({ success: true, token });
});

/* =====================================
   ✅ API: Admin Booking Management
===================================== */

app.get("/api/admin/bookings", requireAdminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM bookings ORDER BY created_at DESC"
    );
    res.json({ bookings: result.rows });
  } catch (err) {
    console.error("ADMIN FETCH ERROR:", err);
    res.status(500).json({ error: "Server error fetching bookings" });
  }
});

app.post("/api/admin/bookings/:id/accept", requireAdminAuth, async (req, res) => {
  try {
    const bookingId = parseInt(req.params.id);
    const { confirmed_date, confirmed_time } = req.body || {};

    const result = await pool.query(
      `UPDATE bookings 
       SET 
         status = 'accepted',
         confirmed_date = COALESCE($2, confirmed_date),
         confirmed_time = COALESCE($3, confirmed_time)
       WHERE id = $1 
       RETURNING *`,
      [bookingId, confirmed_date || null, confirmed_time || null]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Booking not found" });
    }

    res.json({ success: true, booking: result.rows[0] });
  } catch (err) {
    console.error("ACCEPT ERROR:", err);
    res.status(500).json({ error: "Server error accepting booking" });
  }
});

app.post("/api/admin/bookings/:id/reject", requireAdminAuth, async (req, res) => {
  try {
    const bookingId = parseInt(req.params.id);
    const { suggested_date, suggested_time } = req.body || {};

    const result = await pool.query(
      `UPDATE bookings 
       SET 
         status = 'rejected',
         suggested_date = COALESCE($2, suggested_date),
         suggested_time = COALESCE($3, suggested_time)
       WHERE id = $1 
       RETURNING *`,
      [bookingId, suggested_date || null, suggested_time || null]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Booking not found" });
    }

    res.json({ success: true, booking: result.rows[0] });
  } catch (err) {
    console.error("REJECT ERROR:", err);
    res.status(500).json({ error: "Server error rejecting booking" });
  }
});

app.delete("/api/admin/bookings/:id", requireAdminAuth, async (req, res) => {
  try {
    const bookingId = parseInt(req.params.id);

    const result = await pool.query(
      "DELETE FROM bookings WHERE id = $1 RETURNING id",
      [bookingId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Booking not found" });
    }

    res.json({ success: true, deletedId: result.rows[0].id });
  } catch (err) {
    console.error("DELETE ERROR:", err);
    res.status(500).json({ error: "Server error deleting booking" });
  }
});

/* =====================================
   ✅ Start Server
===================================== */

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
