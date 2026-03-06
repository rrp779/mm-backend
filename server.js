require("dotenv").config();

const HOST = "192.168.31.143";
const PORT = 5500;

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const axios = require("axios");

const app = express();

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

/* ------------------ IMAGE UPLOAD ------------------ */
const storage = multer.diskStorage({
  destination: "./uploads/",
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  },
});

const upload = multer({ storage });

app.use("/uploads", express.static("uploads"));

app.post("/api/upload", upload.single("image"), (req, res) => {
  res.json({
    imageUrl: `http://${HOST}:${PORT}/uploads/${req.file.filename}`
  });
});

/* ------------------ VIDEO UPLOAD ------------------ */
 
 

app.post("/api/upload-video", upload.single("video"), (req,res)=>{

 res.json({
  videoUrl: `http://${HOST}:${PORT}/uploads/${req.file.filename}`
 })

})


/* ------------------ SECTION API ------------------ */

app.get("/api/sections", async (req, res) => {
  const sections = await Section.find().sort({ order: 1 });
  res.json(sections);
});

app.post("/api/sections", async (req, res) => { 
  const section = new Section(req.body);
  await section.save();
  res.json(section);
});

app.put("/api/sections/:id", async (req, res) => {
  const updated = await Section.findByIdAndUpdate(
    req.params.id,
    req.body,
    { new: true }
  );
  res.json(updated);
});

app.delete("/api/sections/:id", async (req, res) => {
  await Section.findByIdAndDelete(req.params.id);
  res.json({ success: true });
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