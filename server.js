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

const NodeCache = require("node-cache");
const cache = new NodeCache({ stdTTL: 60 }); 

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
    // 🔥 1. check cache
    const cached = cache.get("sections");

    if (cached) {
      console.log("⚡ CACHE HIT");
      return res.json(cached);
    }

    // 🔥 2. DB call
    console.log("🐢 DB HIT");
    const sections = await Section.find().sort({ order: 1 }).lean(); 

    // 🔥 3. save in cache
    cache.set("sections", sections);

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

    cache.del("sections"); // 🔥 clear cache

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

    cache.del("sections"); // 🔥 clear cache

    res.json(updated);
  } catch (err) {
    console.error("Update section error:", err);
    res.status(500).json({});
  }
});

app.delete("/api/sections/:id", async (req, res) => {
  try {
    await Section.findByIdAndDelete(req.params.id);

    cache.del("sections"); // 🔥 clear cache

    res.json({ success: true });
  } catch (err) {
    console.error("Delete section error:", err);
    res.status(500).json({});
  }
});



/* ================= SHOPIFY PRODUCT (CACHED) ================= */

app.get("/api/products/:id", async (req, res) => {
  try {
    const productId = decodeURIComponent(req.params.id);
    const cacheKey = `product_${productId}`;

    const cached = cache.get(cacheKey);
    if (cached) {
      console.log("⚡ PRODUCT CACHE HIT");
      return res.json(cached);
    }

    console.log("🐢 PRODUCT API HIT");

    const response = await axios.post(
      `https://${process.env.SHOPIFY_STORE}/admin/api/2024-04/graphql.json`,
      {
        query: `
{
  product(id: "${productId}") {
    id
    title
    descriptionHtml
    images(first: 10) {
      edges { node { url } }
    }
    variants(first: 50) {
      edges {
        node {
          id
          title
          price
          compareAtPrice
        }
      }
    }
  }
}
`,
      },
      {
        headers: {
          "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN,
          "Content-Type": "application/json",
        },
        timeout: 10000,
      }
    );

    const product = response.data.data.product;

    cache.set(cacheKey, product, 300);

    res.json(product);

  } catch (err) {
    console.error("Product error:", err.message);
    res.status(500).json({});
  }
});

/* ================= SHOPIFY COLLECTIONS (CACHED) ================= */

app.get("/api/shopify/collections", async (req, res) => {
  try {
    const cacheKey = "collections";

    const cached = cache.get(cacheKey);
    if (cached) {
      console.log("⚡ COLLECTION CACHE HIT");
      return res.json(cached);
    }

    console.log("🐢 COLLECTION API HIT");

    const response = await axios.get(
      `https://${process.env.SHOPIFY_STORE}/admin/api/2024-04/collections.json?limit=20`,
      {
        headers: {
          "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN,
        },
        timeout: 10000,
      }
    );

    const collections = (response.data.collections || []).map((c) => ({
      id: c.admin_graphql_api_id,
      handle: c.handle,
      title: c.title,
      image: c.image?.src || "",
    }));

    cache.set(cacheKey, collections, 300);

    res.json(collections);

  } catch (err) {
    console.error("Collections error:", err.message);
    res.status(500).json([]);
  }
});

/* ================= SHOPIFY SEARCH (CACHED) ================= */

app.get("/api/shopify/search", async (req, res) => {
  const { type = "product", q = "" } = req.query;

  if (!q) return res.json([]);

  try {
    const cacheKey = `search_${type}_${q}`;

    const cached = cache.get(cacheKey);
    if (cached) {
      console.log("⚡ SEARCH CACHE HIT");
      return res.json(cached);
    }

    console.log("🐢 SEARCH API HIT");

    const query = `
    {
      products(first: 20, query: "title:*${q}* OR vendor:*${q}*") {
        edges {
          node {
            id
            title
            featuredImage { url }
          }
        }
      }
      collections(first: 20, query: "title:*${q}*") {
        edges {
          node {
            id
            title
            image { url }
          }
        }
      }
    }
    `;

    const response = await axios.post(
      `https://${process.env.SHOPIFY_STORE}/admin/api/2024-04/graphql.json`,
      { query },
      {
        headers: {
          "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN,
          "Content-Type": "application/json",
        },
        timeout: 10000,
      }
    );

    const data = response.data.data;

    let result = [];

    if (type === "product") {
      result = data.products.edges.map((e) => ({
        id: e.node.id,
        title: e.node.title,
        image: e.node.featuredImage?.url || "",
      }));
    }

    if (type === "collection") {
      result = data.collections.edges.map((e) => ({
        id: e.node.id,
        title: e.node.title,
        image: e.node.image?.url || "",
      }));
    }

    cache.set(cacheKey, result, 120);

    res.json(result);

  } catch (err) {
    console.error("Search error:", err.message);
    res.status(500).json([]);
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