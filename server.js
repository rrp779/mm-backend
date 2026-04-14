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

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});



app.use(cors());
app.use(express.json());

 
/* ------------------ SCHEMA ------------------ */
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
      video: String,          // uploaded reel video
      thumbnail: String,      // reel cover image
    },
  ],
});

const Section = mongoose.model("Section", SectionSchema);

 
const ImageKit = require("imagekit");

const upload = multer(); // memory storage

const imagekit = new ImageKit({
  publicKey: process.env.IMAGEKIT_PUBLIC_KEY,
  privateKey: process.env.IMAGEKIT_PRIVATE_KEY,
  urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT,
});
/* ------------------ IMAGE UPLOAD ------------------ */
app.post("/api/upload", upload.single("image"), async (req, res) => {
  try {
    const file = req.file;

    const response = await imagekit.upload({
      file: file.buffer,
      fileName: Date.now() + "_" + file.originalname,
      folder: "uploads",
    });

    res.json({
      imageUrl: response.url, // ✅ CLOUD URL
    });

  } catch (err) {
    console.error("Image upload error:", err);
    res.status(500).json({ error: "Upload failed" });
  }
});

app.post("/api/upload-video", upload.single("video"), async (req, res) => {
  try {
    const file = req.file;

    const response = await imagekit.upload({
      file: file.buffer,
      fileName: Date.now() + "_" + file.originalname,
      folder: "videos",
    });

    res.json({
      videoUrl: response.url, // ✅ CLOUD URL
    });

  } catch (err) {
    console.error("Video upload error:", err);
    res.status(500).json({ error: "Upload failed" });
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


/* ------------------ TRENDING SCHEMA ------------------ */

const TrendingSchema = new mongoose.Schema({
  productId: String,
  views: { type: Number, default: 1 },
  date: { type: Date, default: Date.now },
});

const Trending = mongoose.model("Trending", TrendingSchema);


/* ------------------ TRACK PRODUCT VIEW ------------------ */

app.post("/api/trending/view", async (req, res) => {
  try {

    const { productId } = req.body;

    if (!productId) {
      return res.json({ success: false });
    }

    const today = new Date();
    today.setHours(0,0,0,0);

    let record = await Trending.findOne({
      productId,
      date: { $gte: today }
    });

    if (record) {
      record.views += 1;
      await record.save();
    } else {
      await Trending.create({
        productId,
        views: 1
      });
    }

    res.json({ success: true });

  } catch (err) {
    console.error("Trending view error:", err);
    res.json({ success: false });
  }
});



/* ------------------ TRENDING PRODUCTS ------------------ */

app.get("/api/trending", async (req, res) => {
  try {

    const last7days = new Date();
    last7days.setDate(last7days.getDate() - 7);

    const trending = await Trending.aggregate([
      { $match: { date: { $gte: last7days } } },
      {
        $group: {
          _id: "$productId",
          views: { $sum: "$views" }
        }
      },
      { $sort: { views: -1 } },
      { $limit: 20 }
    ]);

    res.json(trending);

  } catch (err) {
    console.error("Trending fetch error:", err);
    res.json([]);
  }
});


/* ------------------ BEST SELLING ------------------ */

app.get("/api/shopify/best-selling", async (req, res) => {
  try {

    const response = await axios.get(
      `https://${process.env.SHOPIFY_STORE}/admin/api/2024-04/products.json?limit=50&order=best-selling`,
      {
        headers: {
          "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN,
        },
      }
    );

    const products = (response.data.products || []).map((p) => ({
      id: p.admin_graphql_api_id,
      title: p.title,
      vendor: p.vendor,
      productType: p.product_type,
      image: p.image?.src || "",
      price: p.variants?.[0]?.price || "0",
      totalInventory: p.variants?.[0]?.inventory_quantity || 0,
    }));

    res.json(products);

  } catch (err) {
    console.error("Best Selling Error:", err.response?.data || err.message);
    res.json([]);
  }
});

/* ------------------ SHOPIFY SEARCH ------------------ */

app.get("/api/shopify/search", async (req, res) => {
  const { type = "product", q = "" } = req.query;

  if (!q) return res.json([]);

  try {

    const query = `
    {
      products(first: 20, query: "title:*${q}* OR vendor:*${q}*") {
        edges {
          node {
            id
            title
            vendor
            featuredImage {
              url
            }
          }
        }
      }

      collections(first: 20, query: "title:*${q}*") {
        edges {
          node {
            id
            title
            image {
              url
            }
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
      }
    );

    const data = response.data.data;

    if (type === "product") {
      const products = data.products.edges.map((e) => ({
        id: e.node.id,
        title: e.node.title,
        image: e.node.featuredImage?.url || "",
      }));

      return res.json(products);
    }

    if (type === "collection") {
      const collections = data.collections.edges.map((e) => ({
        id: e.node.id,
        title: e.node.title,
        image: e.node.image?.url || "",
      }));

      return res.json(collections);
    }

    res.json([]);

  } catch (err) {
    console.error("GraphQL Search Error:", err.response?.data || err.message);
    res.status(500).json([]);
  }
});


/* ------------------ SHOPIFY COUPONS ------------------ */

app.get("/api/shopify/coupons", async (req, res) => {
  try {

    const priceRulesResponse = await axios.get(
      `https://${process.env.SHOPIFY_STORE}/admin/api/2024-04/price_rules.json`,
      {
        headers: {
          "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN,
        },
      }
    );

    const rules = priceRulesResponse.data.price_rules || [];

    let coupons = [];

    for (const rule of rules) {

      const codesResponse = await axios.get(
        `https://${process.env.SHOPIFY_STORE}/admin/api/2024-04/price_rules/${rule.id}/discount_codes.json`,
        {
          headers: {
            "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN,
          },
        }
      );

      const codes = codesResponse.data.discount_codes || [];

      codes.forEach((code) => {

       coupons.push({
  id: code.id,
  title: rule.title,
  code: code.code,

  discount_type: rule.value_type || "buy_x_get_y",

  value: rule.value,

  minimum:
    rule.prerequisite_subtotal_range?.greater_than_or_equal_to || null,

  starts_at: rule.starts_at,
  ends_at: rule.ends_at,

  buy_quantity: rule.prerequisite_quantity_range?.greater_than_or_equal_to || null,

  get_quantity: rule.entitled_quantity || null,
});
      });

    }

    res.json(coupons);

  } catch (err) {

    console.error("Coupons Fetch Error:", err.response?.data || err.message);

    res.status(500).json([]);

  }
});

/* ------------------ SINGLE PRODUCT (ADMIN GRAPHQL) ------------------ */

app.get("/api/products/:id", async (req, res) => {
  try {
    const productId = decodeURIComponent(req.params.id);

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
      edges {
        node { url }
      }
    }
    variants(first: 50) {
      edges {
        node {
          id
          title
          availableForSale
          inventoryPolicy
          inventoryQuantity
          image {
            url
          }
          price
          compareAtPrice
          selectedOptions {
            name
            value
          }
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
      }
    );

    // 🔥 Handle GraphQL errors safely
    if (!response.data.data || !response.data.data.product) {
      console.error("GraphQL Error:", response.data);
      return res.status(500).json({});
    }

    res.json(response.data.data.product);

  } catch (err) {
    console.error("Product Fetch Error:", err.response?.data || err.message);
    res.status(500).json({});
  }
});


app.get("/api/shopify/collections", async (req, res) => {
  try {
    const response = await axios.get(
      `https://${process.env.SHOPIFY_STORE}/admin/api/2024-04/collections.json?limit=20`,
      {
        headers: {
          "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN,
        },
      }
    );

    const collections = (response.data.collections || []).map((c) => ({
      id: c.admin_graphql_api_id,
       handle: c.handle,  
      title: c.title,
      image: c.image?.src || "",
    }));

    res.json(collections);

  } catch (err) {
    console.error("Collections Error:", err.response?.data || err.message);
    res.status(500).json([]);
  }
});


/* ------------------ CREATE PAYMENT ORDER ------------------ */

app.post("/api/payment/create-order", async (req, res) => {
  try {
    const { amount, cart, email, phone } = req.body;

    const receiptId = "order_" + Date.now();

    const options = {
      amount,
      currency: "INR",
      receipt: receiptId,

      notes: {
        email,
        phone,
        cart: JSON.stringify(cart),
        receipt: receiptId,
      },
    };

    const order = await razorpay.orders.create(options);

    res.json(order);

  } catch (error) {
    console.error("Razorpay order error:", error);
    res.status(500).json({ error: "Payment order failed" });
  }
});
 
/* ------------------ VERIFY PAYMENT ------------------ */

app.post("/api/payment/verify", async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,

      first_name,
      last_name,
      email,
      phone,
      address1,
      city,
      state,
      pincode,
      amount
    } = req.body;

    /* ------------------ VERIFY SIGNATURE ------------------ */

    const body = razorpay_order_id + "|" + razorpay_payment_id;

    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.json({ success: false, message: "Invalid signature" });
    }

    /* ------------------ FETCH RAZORPAY ORDER (SECURITY FIX) ------------------ */

    const razorpayOrder = await razorpay.orders.fetch(razorpay_order_id);

    const cart = JSON.parse(razorpayOrder.notes.cart || "[]");

    /* ------------------ PREVENT DUPLICATE ORDER ------------------ */

   const existingOrder = await axios.get(
  `https://${process.env.SHOPIFY_STORE}/admin/api/2024-04/orders.json?status=any&limit=50`,
  {
    headers: {
      "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN,
    },
  }
); 

    const alreadyExists = existingOrder.data.orders.some(o =>
      o.note?.includes(razorpay_payment_id)
    );

    if (alreadyExists) {
      return res.json({ success: true, message: "Order already created" });
    }

    /* ------------------ CREATE SHOPIFY ORDER ------------------ */

    const shopifyOrder = await axios.post(
      `https://${process.env.SHOPIFY_STORE}/admin/api/2024-04/orders.json`,
      {
        order: {
  line_items: cart.map(item => ({
    variant_id: item.variant_id,
    quantity: item.quantity,
  })),

  financial_status: "paid",

  customer: {
    first_name,
    last_name,
    email,
    phone,
  },

  email,

  billing_address: {
    first_name,
    last_name,
    address1,
    city,
    province: state,
    country: "India",
    zip: pincode,
    phone,
  },

  shipping_address: {
    first_name,
    last_name,
    address1,
    city,
    province: state,
    country: "India",
    zip: pincode,
    phone,
  },

  shipping_lines: [
    {
      title: "Free Shipping",
      price: "0.00",
    },
  ],

  transactions: [
    {
      kind: "sale",
      status: "success",
      amount: (amount / 100).toString(),
      gateway: "Razorpay",
    },
  ],

  tags: "razorpay,upi",

  gateway: "Razorpay",

  /* ✅ VERY IMPORTANT ADDITIONS BELOW */

  note: `Razorpay Payment ID: ${razorpay_payment_id}`,

  note_attributes: [
    { name: "Payment ID", value: razorpay_payment_id },
    { name: "Order ID", value: razorpay_order_id },
    { name: "Customer Phone", value: phone },
    { name: "Receipt", value: razorpayOrder.receipt },
  ],

  metafields: [
    {
      namespace: "custom",
      key: "razorpay_payment_id",
      value: razorpay_payment_id,
      type: "single_line_text_field",
    },
    {
      namespace: "custom",
      key: "cart_data",
      value: JSON.stringify(cart),
      type: "json",
    },
  ],

  processing_method: "direct",
},
      },
      {
        headers: {
          "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN,
        },
      }
    );

    res.json({
      success: true,
      order: shopifyOrder.data.order,
    });

  } catch (err) {
    console.error("Payment verify error:", err.response?.data || err.message);

    res.json({ success: false });
  }
});

 

/* ------------------ START SERVER ------------------ */

async function startServer() {
  try {
    
    
    await mongoose.connect(process.env.MONGO_URI);

    console.log("MongoDB Atlas connected ✅");

    const PORT = process.env.PORT || 5500;

    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT} 🚀`);
    });

  } catch (error) {
    console.error("MongoDB connection failed ❌");
    console.error(error);
    process.exit(1);
  }
}

startServer();