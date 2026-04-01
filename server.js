require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const axios = require("axios");

const app = express();

const Razorpay = require("razorpay");
const crypto = require("crypto");

/* ================= GLOBAL ERROR HANDLING ================= */

process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught Exception:", err);
});

process.on("unhandledRejection", (err) => {
  console.error("❌ Unhandled Rejection:", err);
});

/* ================= BASIC SETUP ================= */

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

app.use(cors());
app.use(express.json());

/* ================= HEALTH CHECK ================= */

app.get("/", (req, res) => {
  res.send("API Running ✅");
});

/* ================= SCHEMA ================= */

const SectionSchema = new mongoose.Schema({
  title: String,
  type: String,
  order: Number,
  visible: { type: Boolean, default: true },
  settings: {
    layout: { type: String, default: "column" },
    columns: { type: Number, default: 4 },
    backgroundColor: { type: String, default: "#ffffff" },
    gradientStart: { type: String, default: "" },
    gradientEnd: { type: String, default: "" },
    backgroundImage: { type: String, default: "" },
    overlayOpacity: { type: Number, default: 0 },
    paddingTop: { type: Number, default: 16 },
    paddingBottom: { type: Number, default: 16 },
    borderRadius: { type: Number, default: 0 },
    containerWidth: { type: String, default: "full" },
    sliderStyle: { type: String, default: "small" },
  },
  items: [
    {
      title: String,
      collectionId: String,
      collectionHandle: String,
      productId: String,
      image: String,
      visible: { type: Boolean, default: true },
      video: String,
      thumbnail: String,
    },
  ],
});

const Section = mongoose.model("Section", SectionSchema);

/* ================= IMAGE UPLOAD ================= */

const storage = multer.diskStorage({
  destination: "./uploads/",
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  },
});

const upload = multer({ storage });

app.use("/uploads", express.static("uploads"));

app.post("/api/upload", upload.single("image"), (req, res) => {
  try {
    res.json({
      imageUrl: `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`,
    });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({});
  }
});

/* ================= VIDEO UPLOAD ================= */

app.post("/api/upload-video", upload.single("video"), (req, res) => {
  try {
    res.json({
      videoUrl: `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`,
    });
  } catch (err) {
    console.error("Video upload error:", err);
    res.status(500).json({});
  }
});

/* ================= SECTION API ================= */

app.get("/api/sections", async (req, res) => {
  try {
    const sections = await Section.find().sort({ order: 1 });
    res.json(sections);
  } catch (err) {
    console.error("Sections fetch error:", err);
    res.status(500).json([]);
  }
});

app.post("/api/sections", async (req, res) => {
  try {
    const section = new Section(req.body);
    await section.save();
    res.json(section);
  } catch (err) {
    console.error("Create section error:", err);
    res.status(500).json({});
  }
});

app.put("/api/sections/:id", async (req, res) => {
  try {
    const updated = await Section.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true }
    );
    res.json(updated);
  } catch (err) {
    console.error("Update section error:", err);
    res.status(500).json({});
  }
});

app.delete("/api/sections/:id", async (req, res) => {
  try {
    await Section.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error("Delete section error:", err);
    res.status(500).json({});
  }
});

/* ================= MONGO EVENTS ================= */

mongoose.connection.on("error", (err) => {
  console.error("MongoDB error:", err);
});

/* ================= START SERVER ================= */

async function startServer() {
  try {
    await mongoose.connect(process.env.MONGO_URI);

    console.log("MongoDB Atlas connected ✅");

    const PORT = process.env.PORT || 5500;

    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT} 🚀`);
    });

  } catch (error) {
    console.error("MongoDB connection failed ❌", error);
    process.exit(1);
  }
}

startServer();