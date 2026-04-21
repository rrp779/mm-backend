require("dotenv").config();

 

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const axios = require("axios");

const app = express();

const Razorpay = require("razorpay");
const crypto = require("crypto");
const PDFDocument = require("pdfkit");

const NodeCache = require("node-cache");
const cache = new NodeCache({ stdTTL: 60 });  
const Review = require("./models/Review");

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const SHIPROCKET_TOKEN_CACHE_KEY = "shiprocket_jwt";

function toNumericId(gid) {
  if (!gid) return null;
  if (typeof gid === 'number') return gid;
  const str = gid.toString();
  if (str.includes('gid://')) {
    return parseInt(str.split('/').pop());
  }
  return parseInt(str);
}

async function getShopifyCustomerIdByEmail(email) {
  if (!email) return null;
  const query = encodeURIComponent(`email:${String(email).trim()}`);
  const response = await axios.get(
    `https://${process.env.SHOPIFY_STORE}/admin/api/2024-04/customers/search.json?query=${query}`,
    {
      headers: {
        "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN,
      },
    }
  );
  const customerId = response?.data?.customers?.[0]?.id;
  return customerId || null;
}

async function getShiprocketToken() {
  const cached = cache.get(SHIPROCKET_TOKEN_CACHE_KEY);
  if (cached) return cached;

  if (!process.env.SHIPROCKET_EMAIL || !process.env.SHIPROCKET_PASSWORD) {
    const err = new Error("Shiprocket env vars not configured");
    err.code = "SHIPROCKET_ENV_MISSING";
    throw err;
  }

  const response = await axios.post(
    "https://apiv2.shiprocket.in/v1/external/auth/local/register/login",
    {
      email: process.env.SHIPROCKET_EMAIL,
      password: process.env.SHIPROCKET_PASSWORD,
    },
    { timeout: 10000 }
  );

  const token = response?.data?.token;
  if (!token) {
    const err = new Error("Shiprocket auth failed");
    err.data = response?.data;
    throw err;
  }

  // Token is generally valid for 24h; cache for 23h to be safe.
  cache.set(SHIPROCKET_TOKEN_CACHE_KEY, token, 23 * 60 * 60);
  return token;
}

function normalizeShiprocketStatus(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";

  // Shiprocket frequently returns short status codes.
  // Map the requested codes to clean labels; otherwise return raw as-is.
  const code = s.toUpperCase();
  switch (code) {
    case "DLVD":
      return "Delivered";
    case "OFD":
      return "Out for Delivery";
    case "PKD":
      return "Picked Up";
    case "IT":
      return "In Transit";
    case "RTO":
      return "Return to Origin";
    case "CANC":
      return "Cancelled";
    default:
      // Common full-text variants (case-insensitive) — keep output consistent for timeline mapping.
      if (code === "DELIVERED") return "Delivered";
      if (code === "OUT FOR DELIVERY" || code === "OUT_FOR_DELIVERY") return "Out for Delivery";
      if (code === "IN TRANSIT" || code === "IN_TRANSIT") return "In Transit";
      if (code === "PICKED UP" || code === "PICKED_UP") return "Picked Up";
      return s;
  }
}

function getDisplayStatus(order) {
  const financial = String(
    order?.financial_status || order?.financialStatus || order?.displayFinancialStatus || ""
  )
    .trim()
    .toLowerCase();

  const fulfillment = String(
    order?.fulfillment_status || order?.fulfillmentStatus || order?.displayFulfillmentStatus || ""
  )
    .trim()
    .toLowerCase();

  const cancelReason = order?.cancel_reason || order?.cancelReason || null;
  const cancelledAt = order?.cancelled_at || order?.cancelledAt || null;

  // Priority order — check top to bottom:
  if (cancelReason || cancelledAt) return "Cancelled";
  if (financial === "voided") return "Cancelled";
  if (financial === "refunded") return "Refunded";
  if (financial === "partially_refunded") return "Partially Refunded";
  if (fulfillment === "fulfilled") return "Delivered";
  if (fulfillment === "partial") return "Partially Shipped";
  if (financial === "paid" || financial === "partially_paid") return "Confirmed";
  if (financial === "pending") return "Pending Payment";
  return "Processing";
}

function toIsoDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function toIsoDateOnly(value) {
  const iso = toIsoDate(value);
  return iso ? iso.slice(0, 10) : null;
}

function parseShiprocketDdMmmYyyyTime(value) {
  const s = String(value || "").trim();
  if (!s) return null;

  // Expected like: "20 Jul, 2025 14:30" (may be with/without comma).
  const m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})[,]?\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;

  const day = Number(m[1]);
  const mon = String(m[2]).toLowerCase();
  const year = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = m[6] ? Number(m[6]) : 0;

  const monthMap = {
    jan: 0,
    feb: 1,
    mar: 2,
    apr: 3,
    may: 4,
    jun: 5,
    jul: 6,
    aug: 7,
    sep: 8,
    oct: 9,
    nov: 10,
    dec: 11,
  };

  const monthIndex = monthMap[mon];
  if (monthIndex === undefined) return null;

  // Shiprocket times are usually local; we keep it as local time and serialize to ISO.
  const d = new Date(year, monthIndex, day, hour, minute, second);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function extractShiprocketEDD(payload) {
  const etdRaw = payload?.tracking_data?.etd;
  const d = parseShiprocketDdMmmYyyyTime(etdRaw);
  if (!d) return null;
  return d.toISOString().slice(0, 10);
}

function extractShiprocketEvents(payload) {
  const events = [];

  const rawScans = payload?.tracking_data?.shipment_track_activities || [];

  if (Array.isArray(rawScans)) {
    for (const e of rawScans) {
      const rawTime = e?.activity_date || null;
      const parsed = parseShiprocketDdMmmYyyyTime(rawTime) || new Date(rawTime);
      const time = parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null;

      const location = e?.location || "";
      const description = e?.activity || "";

      if (time || location || description) {
        events.push({
          time,
          location: String(location || ""),
          description: String(description || ""),
        });
      }
    }
  }

  return events;
}

async function fetchShiprocketTrackingByAwb(awb) {
  const token = await getShiprocketToken();

  const response = await axios.get(
    `https://apiv2.shiprocket.in/v1/external/courier/track/awb/${encodeURIComponent(String(awb))}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10000,
    }
  );

  const payload = response?.data || {};

  const statusRaw =
    payload?.tracking_data?.current_status ||
    payload?.tracking_data?.shipment_track?.[0]?.current_status ||
    payload?.tracking_data?.shipment_track?.[0]?.status ||
    "";

  const status = normalizeShiprocketStatus(statusRaw);
  const estimatedDelivery = extractShiprocketEDD(payload);
  const events = extractShiprocketEvents(payload);

  return { status, estimatedDelivery, events, raw: payload };
}



app.use(cors());
app.use(express.json());

function toOrderGid(id) {
  const raw = decodeURIComponent(String(id || "")).trim();
  if (!raw) return null;

  if (raw.startsWith("gid://shopify/Order/")) return raw;

  if (/^\d+$/.test(raw)) {
    return `gid://shopify/Order/${raw}`;
  }

  // If caller sends an already-URL-encoded gid (or other gid), allow only Order gids.
  if (raw.startsWith("gid://")) {
    return raw.includes("gid://shopify/Order/") ? raw : null;
  }

  return null;
}

function formatMoney(amount, currency = "INR") {
  const num = Number(amount || 0);
  if (Number.isNaN(num)) return `${currency} 0.00`;
  return `${currency} ${num.toFixed(2)}`;
}

function calculateShipping(cartSubtotal, isCod = false) {
  const amount = Number(cartSubtotal || 0);
  if (amount >= 1500) {
    return { title: "Free Shipping", price: "0.00", code: "FREE" };
  }
  return isCod
    ? { title: "COD Shipping",      price: "120.00", code: "COD" }
    : { title: "Standard Shipping", price: "80.00",  code: "FLAT" };
}

function toProductGid(productIdOrGid) {
  const raw = decodeURIComponent(String(productIdOrGid || "")).trim();
  if (!raw) return null;

  if (raw.startsWith("gid://shopify/Product/")) return raw;
  if (/^\d+$/.test(raw)) return `gid://shopify/Product/${raw}`;

  if (raw.startsWith("gid://")) {
    return raw.includes("gid://shopify/Product/") ? raw : null;
  }

  return null;
}

async function hasPurchasedProduct({ email, productGid }) {
  if (!email || !productGid) return false;
  if (!process.env.SHOPIFY_STORE || !process.env.SHOPIFY_ADMIN_TOKEN) return false;

  const url = `https://${process.env.SHOPIFY_STORE}/admin/api/2024-04/graphql.json`;

  const response = await axios.post(
      url,
      {
        query: `
          query OrdersByEmail($query: String!) {
            orders(first: 25, query: $query, sortKey: CREATED_AT, reverse: true) {
              edges {
                node {
                  id
                  lineItems(first: 100) {
                    edges {
                      node {
                        product { id }
                      }
                    }
                  }
                }
              }
            }
          }
        `,
        variables: { query: `email:${email}` },
      },
      {
        headers: {
          "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN,
          "Content-Type": "application/json",
        },
        timeout: 10000,
      }
    );

  const data = response.data;
  if (data?.errors?.length) return false;

  const orders = data?.data?.orders?.edges || [];
  for (const edge of orders) {
    const lineItems = edge?.node?.lineItems?.edges || [];
    for (const li of lineItems) {
      const id = li?.node?.product?.id;
      if (id && String(id) === String(productGid)) return true;
    }
  }

  return false;
}

function requirePurchasedReview() {
  const raw = String(process.env.REQUIRE_PURCHASED_REVIEW ?? "true").trim().toLowerCase();
  return !(raw === "false" || raw === "0" || raw === "no" || raw === "off");
}

async function fetchOrderForInvoice(orderGid) {
  const numericId = String(orderGid)
    .replace("gid://shopify/Order/", "")
    .split("?")[0]
    .trim();

  const response = await axios.get(
    `https://${process.env.SHOPIFY_STORE}/admin/api/2024-04/orders/${numericId}.json`,
    {
      headers: {
        "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN,
      },
      timeout: 10000,
    }
  );

  const order = response?.data?.order;
  if (!order) return null;

  const noteAttrs = {};
  (order.note_attributes || []).forEach((attr) => {
    if (!attr?.name) return;
    noteAttrs[attr.name] = attr.value;
  });

  const nameFromParts = (obj) => {
    const first = String(obj?.first_name || "").trim();
    const last = String(obj?.last_name || "").trim();
    const combined = [first, last].filter(Boolean).join(" ").trim();
    return combined;
  };

  const customerName =
    nameFromParts(order.customer) ||
    nameFromParts(order.billing_address) ||
    nameFromParts(order.shipping_address) ||
    "Customer";

  const customerEmail =
    order.email ||
    order.contact_email ||
    order.customer?.email ||
    "";

  const customerPhone =
    noteAttrs["Customer Phone"] ||
    order.billing_address?.phone ||
    order.shipping_address?.phone ||
    order.customer?.phone ||
    "";

  const billingName = nameFromParts(order.billing_address);
  const shippingName = nameFromParts(order.shipping_address);

  const billingAddress = {
    name: billingName,
    address1: order.billing_address?.address1 || "",
    address2: order.billing_address?.address2 || "",
    city: order.billing_address?.city || "",
    province: order.billing_address?.province || "",
    country: order.billing_address?.country || "",
    zip: order.billing_address?.zip || "",
    phone: order.billing_address?.phone || customerPhone,
  };

  const shippingAddress = {
    name: shippingName,
    address1: order.shipping_address?.address1 || "",
    address2: order.shipping_address?.address2 || "",
    city: order.shipping_address?.city || "",
    province: order.shipping_address?.province || "",
    country: order.shipping_address?.country || "",
    zip: order.shipping_address?.zip || "",
    phone: customerPhone,
  };

  const currency = order.currency || "INR";

  const shippingAmount =
    order.total_shipping_price_set?.shop_money?.amount ||
    order.shipping_lines?.[0]?.price ||
    "0";

  const discountCodes = Array.isArray(order.discount_codes) ? order.discount_codes : [];
  const appliedCouponsFromCodes = discountCodes
    .map((d) => String(d?.code || "").trim())
    .filter(Boolean)
    .join(", ");

  const couponDiscountFromCodes = discountCodes.reduce((sum, d) => {
    const a = Number(d?.amount || 0);
    return sum + (Number.isFinite(a) ? a : 0);
  }, 0);

  const couponDiscountFromNote = Number(noteAttrs["Coupon Discount"] || 0);
  const couponCodeFromNote = String(noteAttrs["Coupon Code"] || "").trim();
  const appliedCoupons = appliedCouponsFromCodes || couponCodeFromNote || "";
  const couponDiscountAmount = (couponDiscountFromCodes > 0
    ? couponDiscountFromCodes
    : (Number.isFinite(couponDiscountFromNote) ? couponDiscountFromNote : 0)
  ).toFixed(2);

  const shippingAmountFromNote = String(noteAttrs["Shipping Amount"] || "").trim();
  const shopifyShip = String(shippingAmount || "").trim();
  const noteShip = String(shippingAmountFromNote || "").trim();
  const finalShippingAmount = (
    Number(shopifyShip || 0) === 0 && Number(noteShip || 0) > 0
      ? noteShip
      : (shopifyShip || noteShip || "0")
  );

  const totalMrpFromNoteRaw = String(noteAttrs["Total MRP"] || "").trim();
  const subtotalForInvoice = totalMrpFromNoteRaw ? totalMrpFromNoteRaw : (order.subtotal_price || "0");

  const finalPayableFromNoteRaw = String(noteAttrs["Final Payable"] || "").trim();
  const totalForInvoice = finalPayableFromNoteRaw
    ? finalPayableFromNoteRaw
    : (order.current_total_price || order.total_price || "0");

  const subtotalNum = Number(subtotalForInvoice || 0);
  const currentTotalNum = Number(totalForInvoice || 0);
  const shippingNum = Number(finalShippingAmount || 0);
  const couponDiscNum = Number(couponDiscountAmount || 0);
  const productDiscountAmount = Math.max(
    0,
    subtotalNum - currentTotalNum + shippingNum - couponDiscNum
  ).toFixed(2);

  return {
    id: order.admin_graphql_api_id || `gid://shopify/Order/${numericId}`,
    name: order.name || "-",
    createdAt: order.created_at || null,
    processedAt: order.processed_at || order.created_at || null,
    displayFinancialStatus: (order.financial_status || "pending").toUpperCase(),
    displayFulfillmentStatus: (order.fulfillment_status || "unfulfilled").toUpperCase(),
    displayStatus: getDisplayStatus(order),

    customerName,
    customerEmail,
    customerPhone,

    billingAddress,
    shippingAddress,

    subtotalPriceSet: {
      shopMoney: {
        amount: subtotalForInvoice,
        currencyCode: currency,
      },
    },
    totalShippingPriceSet: {
      shopMoney: {
        amount: finalShippingAmount,
        currencyCode: currency,
      },
    },
    currentTotalPriceSet: {
      shopMoney: {
        amount: totalForInvoice,
        currencyCode: currency,
      },
    },
    totalTaxSet: {
      shopMoney: {
        amount: order.total_tax || "0",
        currencyCode: currency,
      },
    },
    lineItems: {
      edges: (order.line_items || []).map((item) => ({
        node: {
          title: item.title || "Item",
          quantity: item.quantity || 1,
          variantTitle: item.variant_title || "",
          originalUnitPriceSet: {
            shopMoney: {
              amount: item.price || "0",
              currencyCode: currency,
            },
          },
        },
      })),
    },
    shippingCharge: finalShippingAmount,
    shippingTitle: order.shipping_lines?.[0]?.title || "Shipping",
    isFreeShipping: Number(finalShippingAmount) === 0,
    shippingAmount: finalShippingAmount,
    couponDiscountAmount,
    appliedCoupons,
    couponCode: appliedCoupons || null,
    couponDiscount: couponDiscountAmount,
    productDiscount: productDiscountAmount,
  };
}

async function fetchOrderForTracking(orderGid) {
  const url = `https://${process.env.SHOPIFY_STORE}/admin/api/2024-04/graphql.json`;

  const response = await axios.post(
    url,
    {
      query: `
        query OrderForTracking($id: ID!) {
          order(id: $id) {
            id
            name
            createdAt
            processedAt
            displayFinancialStatus
            displayFulfillmentStatus
            cancelReason
            cancelledAt
            fulfillments {
              status
              createdAt
              trackingInfo {
                number
                url
                company
              }
            }
          }
        }
      `,
      variables: { id: orderGid },
    },
    {
      headers: {
        "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN,
      },
      timeout: 10000,
    }
  );

  const data = response.data;
  if (data?.errors?.length) {
    const msg = data.errors[0]?.message || "Shopify GraphQL error";
    const err = new Error(msg);
    err.shopifyErrors = data.errors;
    throw err;
  }

  return data?.data?.order || null;
}

function buildOrderTrackingTimeline(order) {
  const createdAt = order?.createdAt || null;
  const processedAt = order?.processedAt || null;
  const fulfillmentStatus = String(order?.displayFulfillmentStatus || "").toUpperCase();

  const fulfillments = Array.isArray(order?.fulfillments) ? order.fulfillments : [];
  const hasFulfillment = fulfillments.length > 0;

  const delivered = fulfillmentStatus === "FULFILLED";
  const shipped =
    delivered ||
    fulfillmentStatus === "IN_PROGRESS" ||
    fulfillmentStatus === "PARTIALLY_FULFILLED" ||
    hasFulfillment;

  // Shopify does not expose "Out for delivery" in Admin API without integrating a shipping provider.
  // We mark it true only when shipped + tracking exists (best-effort), otherwise false.
  const firstTracking = (() => {
    for (const f of fulfillments) {
      const infos = Array.isArray(f?.trackingInfo) ? f.trackingInfo : [];
      const t = infos.find((x) => x?.number || x?.url || x?.company);
      if (t) return t;
    }
    return null;
  })();

  const outForDelivery = Boolean(shipped && !delivered && firstTracking);

  return {
    createdAt,
    processedAt,
    confirmedAt: hasFulfillment ? (fulfillments[0]?.createdAt || processedAt || createdAt) : (processedAt || createdAt),
    steps: [
      { key: "placed", label: "Order placed", completed: Boolean(createdAt), timestamp: createdAt },
      { key: "confirmed", label: "Confirmed", completed: Boolean(hasFulfillment), timestamp: hasFulfillment ? (fulfillments[0]?.createdAt || processedAt || createdAt) : null },
      { key: "shipped", label: "Shipped", completed: Boolean(shipped), timestamp: shipped ? (fulfillments[0]?.createdAt || processedAt || createdAt) : null },
      { key: "out_for_delivery", label: "Out for delivery", completed: Boolean(outForDelivery), timestamp: null },
      { key: "delivered", label: "Delivered", completed: Boolean(delivered), timestamp: null },
    ],
    tracking: firstTracking
      ? {
          number: firstTracking.number || null,
          url: firstTracking.url || null,
          company: firstTracking.company || null,
        }
      : null,
  };
}

function buildInvoicePdfBuffer(order) {
  const doc = new PDFDocument({ size: "A4", margin: 0 });
  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const brandColor = "#EA0180";
  const darkColor  = "#1a1a2e";
  const grayColor  = "#6c757d";
  const lightGray  = "#f8f9fa";
  const borderColor = "#dee2e6";
  const M = 36;
  const pageW = doc.page.width;   // 595
  const pageH = doc.page.height;  // 842
  const cW = pageW - M * 2;       // 523

  const orderName = (() => {
    const r = String(order?.name || "").trim();
    if (!r || r.includes("gid://")) return "-";
    return r.startsWith("#") ? r : `#${r}`;
  })();

  const dateStr = (() => {
    const d = new Date(order?.processedAt || order?.createdAt || "");
    if (isNaN(d)) return "-";
    return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  })();

  const currency =
    order?.currentTotalPriceSet?.shopMoney?.currencyCode ||
    order?.subtotalPriceSet?.shopMoney?.currencyCode ||
    "INR";

  const subtotal = Number(order?.subtotalPriceSet?.shopMoney?.amount || 0);
  const shipAmt  = Number(order?.shippingAmount || order?.totalShippingPriceSet?.shopMoney?.amount || 0);
  const tax      = Number(order?.totalTaxSet?.shopMoney?.amount || 0);
  const total    = Number(order?.currentTotalPriceSet?.shopMoney?.amount || 0);
  const couponDisc = Number(order?.couponDiscountAmount || 0);
  const productDisc = Math.max(
    0,
    subtotal - total + shipAmt - couponDisc
  );

  const ba = order?.billingAddress || {};
  const sa = order?.shippingAddress || {};

  const customerName = String(order?.customerName || "").trim();
  const customerEmail = String(order?.customerEmail || "").trim();
  const customerPhone = String(order?.customerPhone || "").trim();

  const safeCustomerName =
    customerName && customerName.trim() && customerName.trim().toLowerCase() !== "customer"
      ? customerName.trim()
      : "";

  const billCityProvince = [ba.city, ba.province].filter(Boolean).join(", ");
  const billZipCountry = [ba.zip, ba.country].filter(Boolean).join(", ");

  const shipCityProvince = [sa.city, sa.province].filter(Boolean).join(", ");
  const shipZipCountry = [sa.zip, sa.country].filter(Boolean).join(", ");

  const billLines = [
    { text: ba.name || safeCustomerName || null, bold: true },
    { text: customerEmail || null, bold: false },
    { text: ba.address1 || null, bold: false },
    { text: ba.address2 || null, bold: false },
    { text: billCityProvince || null, bold: false },
    { text: billZipCountry || null, bold: false },
    { text: ba.phone || customerPhone || null, bold: false },
  ].filter((l) => l.text && String(l.text).trim().length > 0);
  if (!billLines.length) billLines.push({ text: "-", bold: false });

  const shipLines = [
    { text: sa.name || safeCustomerName || null, bold: true },
    { text: sa.address1 || null, bold: false },
    { text: sa.address2 || null, bold: false },
    { text: shipCityProvince || null, bold: false },
    { text: shipZipCountry || null, bold: false },
    { text: sa.phone || customerPhone || null, bold: false },
  ].filter((l) => l.text && String(l.text).trim().length > 0);
  if (!shipLines.length) shipLines.push({ text: "-", bold: false });

  function text1Line(text, x, y, opts) {
    doc.text(String(text || ""), x, y, { ...(opts || {}), lineBreak: false, ellipsis: true });
  }

  // ── HEADER (0–56) — compact ──
  doc.rect(0, 0, pageW, 56).fill(brandColor);

  const logoCandidates = [
    path.join(__dirname, "assets", "logo.png"),
    path.join(__dirname, "assets", "Logo.png"),
    path.join(__dirname, "assets", "logo.jpg"),
    path.join(__dirname, "src", "assets", "logo.png"),
    path.join(__dirname, "images", "logo.png"),
    path.join(__dirname, "public", "logo.png"),
    path.join(__dirname, "public", "images", "logo.png"),
  ];

  const logoPath = logoCandidates.find((p) => fs.existsSync(p)) || null;

  if (logoPath) {
    // No white circle — just render logo directly, fitted to height
    doc.roundedRect(M, 8, 120, 40, 4).fill("#ffffff");
    doc.image(logoPath, M + 2, 9, { height: 38, fit: [116, 38] });
  } else {
    doc.circle(M + 16, 28, 14).fill("#ffffff");
    doc.fillColor("#EA0180").font("Helvetica-Bold").fontSize(14)
      .text("M", M + 9, 22, { width: 14, align: "center" });
  }

  // Brand name starts after logo — push right enough
  const textStartX = M + 130;
  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(13)
    .text("Makeup Mystery India", textStartX, 16);
  doc.fillColor("rgba(255,255,255,0.80)").font("Helvetica").fontSize(7.5)
    .text("Premium Beauty & Cosmetics  \u00B7  makeupmysteryindia.in", textStartX, 32);

  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(22)
    .text("INVOICE", 0, 17, { width: pageW - M, align: "right" });

  // ── META ROW (64–108) ──
  const metaY = 64;
  doc.fillColor(darkColor).font("Helvetica-Bold").fontSize(7.5).text("INVOICE NUMBER", M, metaY);
  doc.fillColor(brandColor).font("Helvetica-Bold").fontSize(11).text(orderName, M, metaY + 11);
  doc.fillColor(grayColor).font("Helvetica").fontSize(7.5).text("Invoice Date", M, metaY + 27);
  doc.fillColor(darkColor).font("Helvetica").fontSize(8.5).text(dateStr, M, metaY + 38);

  const statusTxt = String(order?.displayFinancialStatus || "PAID").toUpperCase();
  const badgeClr = statusTxt === "PAID" ? "#28a745" : "#ffc107";
  const bX = pageW - M - 80;
  doc.roundedRect(bX, metaY, 80, 20, 3).fill(badgeClr);
  doc.fillColor("#fff").font("Helvetica-Bold").fontSize(9)
    .text(statusTxt, bX, metaY + 6, { width: 80, align: "center" });
  doc.fillColor(grayColor).font("Helvetica").fontSize(7.5)
    .text(String(order?.displayFulfillmentStatus || "UNFULFILLED"), bX, metaY + 28, { width: 80, align: "center" });

  // ── DIVIDER ──
  doc.strokeColor(borderColor).lineWidth(0.5).moveTo(M, 112).lineTo(pageW - M, 112).stroke();

  // ── BILL / SHIP BOXES (118–...) ──
  const boxY = 118;
  const lineH = 11;

  const isSameAddress =
    (ba.address1 || "") === (sa.address1 || "") &&
    (ba.city || "") === (sa.city || "") &&
    (ba.zip || "") === (sa.zip || "");

  const renderAddressLines = (lines, x, yStart, width) => {
    let y = yStart;
    lines.forEach((l) => {
      const isBold = Boolean(l.bold);
      doc
        .fillColor(isBold ? darkColor : grayColor)
        .font(isBold ? "Helvetica-Bold" : "Helvetica")
        .fontSize(isBold ? 8.5 : 7.5);
      text1Line(l.text, x, y, { width });
      y += isBold ? 13 : lineH;
    });
    return y;
  };

  let boxH;
  let tableStartY;

  if (isSameAddress) {
    boxH = Math.max(60, 20 + shipLines.length * lineH + 6);

    doc.rect(M, boxY, cW, boxH).fillAndStroke(lightGray, borderColor);
    doc.rect(M, boxY, 175, 13).fill(brandColor);
    doc.fillColor("#fff").font("Helvetica-Bold").fontSize(6.5)
      .text("BILLING & SHIPPING ADDRESS", M + 5, boxY + 4);

    renderAddressLines(shipLines, M + 6, boxY + 18, cW - 12);

    tableStartY = boxY + boxH + 8;
  } else {
    const colW = (cW - 14) / 2;
    boxH = Math.max(60, 20 + Math.max(billLines.length, shipLines.length) * lineH + 6);

    // Bill To
    doc.rect(M, boxY, colW, boxH).fillAndStroke(lightGray, borderColor);
    doc.rect(M, boxY, 44, 13).fill(brandColor);
    doc.fillColor("#fff").font("Helvetica-Bold").fontSize(6.5)
      .text("BILL TO", M + 5, boxY + 4);
    renderAddressLines(billLines, M + 6, boxY + 18, colW - 12);

    // Ship To
    const sX = M + colW + 14;
    doc.rect(sX, boxY, colW, boxH).fillAndStroke(lightGray, borderColor);
    doc.rect(sX, boxY, 46, 13).fill(darkColor);
    doc.fillColor("#fff").font("Helvetica-Bold").fontSize(6.5)
      .text("SHIP TO", sX + 5, boxY + 4);
    renderAddressLines(shipLines, sX + 6, boxY + 18, colW - 12);

    tableStartY = boxY + boxH + 8;
  }

  // ── ITEMS TABLE ──
  const tHdrH = 20;
  const tRowH = 22;
  const tY0 = tableStartY;

  const COL = {
    item:  { x: M,       w: 258 },
    qty:   { x: M + 262, w: 36  },
    unit:  { x: M + 302, w: 98  },
    total: { x: M + 404, w: 119 },
  };

  doc.rect(M, tY0, cW, tHdrH).fill(darkColor);
  doc.fillColor("#fff").font("Helvetica-Bold").fontSize(7.5);
  text1Line("ITEM DESCRIPTION", COL.item.x + 6, tY0 + 6, { width: COL.item.w - 6 });
  text1Line("QTY", COL.qty.x, tY0 + 6, { width: COL.qty.w, align: "center" });
  text1Line("UNIT PRICE", COL.unit.x, tY0 + 6, { width: COL.unit.w, align: "right" });
  text1Line("TOTAL", COL.total.x, tY0 + 6, { width: COL.total.w - 4, align: "right" });

  let rY = tY0 + tHdrH;
  const footerY = pageH - 42;
  const reserveBelowTable = 120;
  const maxTableBottom = footerY - reserveBelowTable;
  const maxRows = Math.max(0, Math.floor((maxTableBottom - rY) / tRowH));

  const edges = (order?.lineItems?.edges || []).slice(0, maxRows);
  edges.forEach((edge, idx) => {
    const nd = edge?.node || {};
    const qty = Number(nd.quantity || 0);
    const unit = Number(nd?.originalUnitPriceSet?.shopMoney?.amount || 0);
    const tot = unit * qty;
    const vari = String(nd.variantTitle || "").trim();
    const title = String(nd.title || "Item");
    const displayTitle = vari && vari.toLowerCase() !== "default title" ? `${title} - ${vari}` : title;

    doc.rect(M, rY, cW, tRowH).fill(idx % 2 === 0 ? "#ffffff" : lightGray);
    doc.strokeColor(borderColor).lineWidth(0.3).moveTo(M, rY + tRowH).lineTo(pageW - M, rY + tRowH).stroke();

    doc.fillColor(darkColor).font("Helvetica").fontSize(8);
    text1Line(displayTitle, COL.item.x + 6, rY + 6, { width: COL.item.w - 6 });
    text1Line(String(qty), COL.qty.x, rY + 6, { width: COL.qty.w, align: "center" });
    text1Line(`Rs. ${unit.toFixed(2)}`, COL.unit.x, rY + 6, { width: COL.unit.w, align: "right" });
    text1Line(`Rs. ${tot.toFixed(2)}`, COL.total.x, rY + 6, { width: COL.total.w - 4, align: "right" });

    rY += tRowH;
  });

  // ── TOTALS ──
  rY += 10;
  const tLblX = pageW - M - 210;
  const tValW = 100;
  const tLblW = 106;

  function tRow(lbl, val, bold, clr) {
    const fs = bold ? 9 : 8;
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(fs).fillColor(grayColor);
    text1Line(lbl, tLblX, rY, { width: tLblW });
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(fs).fillColor(clr || darkColor);
    text1Line(val, tLblX + tLblW, rY, { width: tValW, align: "right" });
    rY += bold ? 15 : 13;
  }

  tRow("Subtotal", `Rs. ${subtotal.toFixed(2)}`);

  if (productDisc > 0) {
    tRow("Discount", `-Rs. ${productDisc.toFixed(2)}`, false, "#28a745");
  }

  if (couponDisc > 0) {
    const couponLabel = order?.appliedCoupons
      ? `Coupon (${order.appliedCoupons})`
      : "Coupon Discount";
    tRow(couponLabel, `-Rs. ${couponDisc.toFixed(2)}`, false, "#28a745");
  }

  tRow(
    "Shipping",
    shipAmt === 0 ? "FREE" : `Rs. ${shipAmt.toFixed(2)}`,
    false,
    shipAmt === 0 ? "#28a745" : darkColor
  );

  if (tax > 0) tRow("Tax", `Rs. ${tax.toFixed(2)}`);

  doc.strokeColor(brandColor).lineWidth(1).moveTo(tLblX, rY + 2).lineTo(pageW - M, rY + 2).stroke();
  rY += 8;

  const totBgW = tLblW + tValW + 8;
  doc.rect(tLblX - 4, rY - 2, totBgW, 22).fill(brandColor);
  doc.fillColor("#fff").font("Helvetica-Bold").fontSize(9.5);
  text1Line("TOTAL AMOUNT", tLblX, rY + 5, { width: tLblW });
  text1Line(`Rs. ${total.toFixed(2)}`, tLblX + tLblW, rY + 5, { width: tValW, align: "right" });

  // ── FOOTER (pinned) ──
  doc.rect(0, footerY, pageW, 42).fill(darkColor);
  doc.fillColor("#fff").font("Helvetica-Bold").fontSize(9)
    .text("Thank you for your purchase!", 0, footerY + 8, { width: pageW, align: "center" });
  doc.fillColor("rgba(255,255,255,0.60)").font("Helvetica").fontSize(7)
    .text("support@makeupmysteryindia.com  |  makeupmysteryindia.in", 0, footerY + 24, { width: pageW, align: "center" });

  doc.end();
  return done;
}

 
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
      useUniqueFileName: true,
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
    const now = new Date();

    for (const rule of rules) {
      const startsAt = rule.starts_at ? new Date(rule.starts_at) : null;
      const endsAt = rule.ends_at ? new Date(rule.ends_at) : null;
      const is_expired = endsAt ? endsAt < now : false;
      const is_started = startsAt ? startsAt <= now : true;

      const discountType = rule.value_type;
      if (discountType !== "fixed_amount" && discountType !== "percentage") {
        continue; // only support percentage & fixed_amount
      }

      const valueNumber = Math.abs(Number.parseFloat(rule.value));
      if (!Number.isFinite(valueNumber) || valueNumber <= 0) continue;

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

  discount_type: discountType,

  value: valueNumber,

  minimum:
    rule.prerequisite_subtotal_range?.greater_than_or_equal_to || null,

  starts_at: rule.starts_at || null,
  ends_at: rule.ends_at || null,
  is_expired,
  is_started,

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

/* ------------------ PRODUCT REVIEWS ------------------ */

app.get("/api/review/:productId", async (req, res) => {
  try {
    const productId = decodeURIComponent(String(req.params.productId || "")).trim();

    if (!productId) return res.json([]);

    const reviews = await Review.find({ productId })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    res.json(
      reviews.map((r) => ({
        productId: r.productId,
        rating: r.rating,
        body: r.body,
        reviewer: r.reviewer,
        timestamp: r.createdAt,
      }))
    );
  } catch (err) {
    console.error("Reviews Fetch Error:", err.message);
    res.status(500).json([]);
  }
});

app.post("/api/review", async (req, res) => {
  try {
    const { productId, rating, body, reviewer } = req.body || {};

    const normalizedProductId = String(productId || "").trim();
    const normalizedRating = Number(rating);
    const normalizedBody = String(body || "").trim();

    const reviewerName = String(reviewer?.name || "").trim();
    const reviewerEmail = String(reviewer?.email || "").trim().toLowerCase();

    if (!normalizedProductId) {
      return res.status(400).json({ error: "productId is required" });
    }
    if (!Number.isFinite(normalizedRating) || normalizedRating < 1 || normalizedRating > 5) {
      return res.status(400).json({ error: "rating must be between 1 and 5" });
    }
    if (!normalizedBody) {
      return res.status(400).json({ error: "review text is required" });
    }
    if (!reviewerName || !reviewerEmail) {
      return res.status(400).json({ error: "reviewer name and email are required" });
    }

    // Optional (preferred): restrict reviews to purchased users.
    if (requirePurchasedReview()) {
      const productGid = toProductGid(normalizedProductId);
      if (productGid) {
        if (!process.env.SHOPIFY_STORE || !process.env.SHOPIFY_ADMIN_TOKEN) {
          return res.status(500).json({ error: "Shopify credentials not configured for purchase validation" });
        }

        try {
          const purchased = await hasPurchasedProduct({ email: reviewerEmail, productGid });
          if (!purchased) {
            return res.status(403).json({ error: "Only purchased users can review this product" });
          }
        } catch (e) {
          const status = e?.response?.status;
          if (status === 401 || status === 403) {
            return res.status(502).json({ error: "Shopify Admin token is invalid for purchase validation" });
          }
          return res.status(502).json({ error: "Purchase validation failed" });
        }
      }
    }

    const saved = await Review.create({
      productId: normalizedProductId,
      rating: normalizedRating,
      body: normalizedBody,
      reviewer: {
        name: reviewerName,
        email: reviewerEmail,
      },
    });

    res.json({
      success: true,
      review: {
        productId: saved.productId,
        rating: saved.rating,
        body: saved.body,
        reviewer: saved.reviewer,
        timestamp: saved.createdAt,
      },
    });
  } catch (err) {
    console.error("Review Create Error:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to submit review" });
  }
});

/* ------------------ ORDER INVOICE (PDF) ------------------ */

app.get("/api/order/:id", async (req, res) => {
  try {
    const orderGid = toOrderGid(req.params.id);

    if (!orderGid) {
      return res.status(400).json({ error: "Invalid order id" });
    }

    if (!process.env.SHOPIFY_STORE || !process.env.SHOPIFY_ADMIN_TOKEN) {
      return res.status(500).json({ error: "Shopify env vars not configured" });
    }

    const order = await fetchOrderForInvoice(orderGid);

    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    return res.status(200).json(order);
  } catch (err) {
    console.error("Order Fetch Error:", err.response?.data || err.message);
    console.error("Order Fetch Stack:", err.stack);
    return res.status(500).json({ error: "Order fetch failed" });
  }
});

app.get("/api/order/:id/invoice", async (req, res) => {
  try {
    const orderGid = toOrderGid(req.params.id);

    if (!orderGid) {
      return res.status(400).json({ error: "Invalid order id" });
    }

    if (!process.env.SHOPIFY_STORE || !process.env.SHOPIFY_ADMIN_TOKEN) {
      return res.status(500).json({ error: "Shopify env vars not configured" });
    }

    const order = await fetchOrderForInvoice(orderGid);

    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    const pdfBuffer = await buildInvoicePdfBuffer(order);

    const safeName = String(order?.name || "order").replace(/[^a-zA-Z0-9-_]/g, "");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="invoice-${safeName || "order"}.pdf"`);
    return res.status(200).send(pdfBuffer);
  } catch (err) {
    console.error("Invoice Error:", err.response?.data || err.message);
    console.error("Invoice Stack:", err.stack);
    return res.status(500).json({ error: "Invoice generation failed" });
  }
});

/* ------------------ ORDER TRACKING ------------------ */

app.get("/api/order/:id/tracking", async (req, res) => {
  try {
    const orderGid = toOrderGid(req.params.id);

    if (!orderGid) {
      return res.status(400).json({ error: "Invalid order id" });
    }

    if (!process.env.SHOPIFY_STORE || !process.env.SHOPIFY_ADMIN_TOKEN) {
      return res.status(500).json({ error: "Shopify env vars not configured" });
    }

    const order = await fetchOrderForTracking(orderGid);

    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    const displayStatus = getDisplayStatus({
      displayFinancialStatus: order?.displayFinancialStatus,
      displayFulfillmentStatus: order?.displayFulfillmentStatus,
      cancelReason: order?.cancelReason,
      cancelledAt: order?.cancelledAt,
    });

    const shopifyTimeline = buildOrderTrackingTimeline(order);

    const trackingNumber = shopifyTimeline?.tracking?.number || null;
    const courier = shopifyTimeline?.tracking?.company || null;
    let liveTrackingUrl = shopifyTimeline?.tracking?.url || null;

    let shiprocketAvailable = false;
    let currentStatus = "";
    let estimatedDelivery = null;
    let trackingEvents = [];

    if (trackingNumber) {
      try {
        const shiprocket = await fetchShiprocketTrackingByAwb(trackingNumber);
        shiprocketAvailable = true;
        currentStatus = shiprocket.status || "";
        estimatedDelivery = shiprocket.estimatedDelivery || null;
        trackingEvents = shiprocket.events || [];
      } catch (e) {
        shiprocketAvailable = false;
        console.error("Shiprocket Tracking Error:", e?.response?.data || e.message);
      }
    }

    if (!currentStatus) {
      const s = String(order?.displayFulfillmentStatus || "").toUpperCase();
      if (s === "FULFILLED") currentStatus = "Delivered";
      else if (s === "IN_PROGRESS" || s === "PARTIALLY_FULFILLED") currentStatus = "In Transit";
      else if (shopifyTimeline?.steps?.find((x) => x?.key === "confirmed")?.completed) currentStatus = "Confirmed";
      else currentStatus = "Order Placed";
    }

    // Keep summary in sync for non-shipped orders (paid/confirmed but no tracking yet).
    if (!trackingNumber && !shiprocketAvailable) {
      currentStatus = displayStatus;
    } else if (displayStatus === "Cancelled" || displayStatus === "Refunded") {
      currentStatus = displayStatus;
    }

    const fulfillments = Array.isArray(order?.fulfillments) ? order.fulfillments : [];
    const hasFulfillment = fulfillments.length > 0;

    const placedTime = toIsoDate(order?.createdAt) || null;
    const firstFulfillmentCreatedAt = (() => {
      const dates = fulfillments
        .map((f) => toIsoDate(f?.createdAt))
        .filter(Boolean)
        .sort();
      return dates.length ? dates[0] : null;
    })();

    // Confirmed = order is paid OR has fulfillment
    const financialStatus = String(
      order?.displayFinancialStatus || ""
    ).toUpperCase();

    const isPaid =
      financialStatus === "PAID" ||
      financialStatus === "PARTIALLY_PAID" ||
      hasFulfillment;

    const confirmedDone = isPaid;
    const confirmedTime = isPaid
      ? (firstFulfillmentCreatedAt || placedTime)
      : null;

    const cleanStatus = normalizeShiprocketStatus(currentStatus);

    const shiprocketShippedStatuses = new Set([
      "Picked Up",
      "In Transit",
      "Out for Delivery",
      "Delivered",
    ]);

    const shippedDone = shiprocketAvailable
      ? shiprocketShippedStatuses.has(cleanStatus)
      : (shopifyTimeline?.steps?.find((x) => x?.key === "shipped")?.completed === true);

    const outForDeliveryDone = shiprocketAvailable
      ? (cleanStatus === "Out for Delivery" || cleanStatus === "Delivered")
      : false;

    const deliveredDone = shiprocketAvailable
      ? (cleanStatus === "Delivered")
      : (shopifyTimeline?.steps?.find((x) => x?.key === "delivered")?.completed === true);

    const sortedEvents = (trackingEvents || [])
      .filter((e) => e?.time)
      .slice()
      .sort((a, b) => String(a.time).localeCompare(String(b.time)));

    const statusFromEvent = (desc) => {
      const s = String(desc || "").trim();
      if (!s) return "";
      const token = s.split(/\s+/)[0].toUpperCase();
      if (["DLVD", "OFD", "PKD", "IT", "RTO", "CANC"].includes(token)) {
        return normalizeShiprocketStatus(token);
      }
      if (["DLVD", "OFD", "PKD", "IT", "RTO", "CANC"].includes(s.toUpperCase())) {
        return normalizeShiprocketStatus(s.toUpperCase());
      }
      return normalizeShiprocketStatus(s);
    };

    const firstEventTimeForStatuses = (statuses) => {
      for (const e of sortedEvents) {
        const ev = statusFromEvent(e?.description);
        if (statuses.has(ev)) return e.time || null;
      }
      return null;
    };

    const shippedTime = shippedDone
      ? (firstEventTimeForStatuses(shiprocketShippedStatuses) || confirmedTime || placedTime)
      : null;

    const outForDeliveryTime = outForDeliveryDone
      ? (firstEventTimeForStatuses(new Set(["Out for Delivery"])) || null)
      : null;

    const deliveredTime = deliveredDone
      ? (sortedEvents.length ? (sortedEvents[sortedEvents.length - 1].time || null) : null)
      : null;

    // Human-friendly fields expected by the Flutter tracking screen
    let estimatedDeliveryText = "Calculating...";
    if (estimatedDelivery) {
      const d = new Date(estimatedDelivery);
      estimatedDeliveryText = Number.isNaN(d.getTime())
        ? String(estimatedDelivery)
        : d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
    } else if (cleanStatus === "Delivered" || currentStatus === "Delivered") {
      estimatedDeliveryText = "Delivered";
    } else if (!trackingNumber) {
      estimatedDeliveryText = "Will update once shipped";
    }

    let courierDisplay = "Not assigned yet";
    if (courier && trackingNumber) courierDisplay = `${courier} • ${trackingNumber}`;
    else if (trackingNumber) courierDisplay = String(trackingNumber);

    if (!liveTrackingUrl && trackingNumber) {
      liveTrackingUrl = `https://shiprocket.co/tracking/${encodeURIComponent(String(trackingNumber))}`;
    }

    return res.json({
      orderId: order.id,
      orderName: order.name,
      trackingNumber,
      courier,
      currentStatus,
      estimatedDelivery,
      displayStatus,
      timeline: [
        { step: "Order Placed", done: true, time: placedTime },
        { step: "Confirmed", done: Boolean(confirmedDone), time: confirmedTime },
        { step: "Shipped", done: Boolean(shippedDone), time: shippedTime },
        { step: "Out for Delivery", done: Boolean(outForDeliveryDone), time: outForDeliveryTime },
        { step: "Delivered", done: Boolean(deliveredDone), time: deliveredTime },
      ],
      trackingEvents,
      liveTrackingUrl,
      shiprocket_available: shiprocketAvailable,
      estimatedDeliveryText,
      courierDisplay,
    });
  } catch (err) {
    console.error("Order Tracking Error:", err.response?.data || err.message);
    const status = err?.response?.status;
    if (status === 401 || status === 403) {
      return res.status(502).json({ error: "Shopify Admin token is invalid" });
    }
    return res.status(500).json({ error: "Failed to fetch tracking" });
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
      amount,
      couponCode,
      couponDiscount,
      shippingAmount,
      totalMrp,
      productDiscount
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
    const cartSubtotal = cart.reduce((sum, item) => {
      return sum + (Number(item.price || 0) * Number(item.quantity || 1));
    }, 0);
    const passedShipping = Number(shippingAmount);
    const hasPassedShipping = Number.isFinite(passedShipping) && passedShipping >= 0;

    const finalShipping = hasPassedShipping
      ? {
          title: passedShipping === 0 ? "Free Shipping" : "Standard Shipping",
          price: passedShipping.toFixed(2),
          code: passedShipping === 0 ? "FREE" : "FLAT",
        }
      : calculateShipping(cartSubtotal, false);

    const couponDisc = Math.max(0, Number(couponDiscount || 0));
    const orderTotal = Math.max(0, cartSubtotal + Number(finalShipping.price) - couponDisc);

    // Only add discount_codes if coupon applied
    const discountCodesPayload = (couponCode && Number(couponDiscount) > 0)
      ? [{
          code: String(couponCode),
          amount: Number(couponDiscount).toFixed(2),
          type: "fixed_amount",
        }]
      : [];

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

    const shopifyCustomerId = await getShopifyCustomerIdByEmail(email);

    const shopifyOrder = await axios.post(
      `https://${process.env.SHOPIFY_STORE}/admin/api/2024-04/orders.json`,
      {
        order: {
  line_items: cart.map(item => ({
    variant_id: toNumericId(item.variant_id),
    quantity: item.quantity,
  })),

  financial_status: "paid",

  customer: shopifyCustomerId ? { id: shopifyCustomerId } : {
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
      title: finalShipping.title,
      price: finalShipping.price,
      code:  finalShipping.code,
    },
  ],

  discount_codes: discountCodesPayload,

  transactions: [
    {
      kind: "sale",
      status: "success",
      amount: orderTotal.toFixed(2),
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
    ...(couponCode ? [
      { name: "Coupon Code", value: String(couponCode) },
      { name: "Coupon Discount", value: String(couponDiscount || 0) },
    ] : []),
    { name: "Shipping Amount", value: String(finalShipping.price) },
    { name: "Final Payable", value: String(orderTotal.toFixed(2)) },
    ...(totalMrp !== undefined && totalMrp !== null ? [{ name: "Total MRP", value: String(totalMrp) }] : []),
    ...(productDiscount !== undefined && productDiscount !== null ? [{ name: "Product Discount", value: String(productDiscount) }] : []),
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
  console.error("FULL ERROR:", err);
  res.json({ success: false, message: err.message });
} 
});

 

/* ------------------ START SERVER ------------------ */

async function startServer() {
  try {
    
    
    await mongoose.connect(process.env.MONGO_URI);

    console.log("MongoDB Atlas connected ✅");

    const PORT = process.env.PORT || 5500;

    const logoCandidates = [
      path.join(__dirname, "assets", "logo.png"),
      path.join(__dirname, "assets", "Logo.png"),
      path.join(__dirname, "assets", "logo.jpg"),
      path.join(__dirname, "src", "assets", "logo.png"),
      path.join(__dirname, "images", "logo.png"),
      path.join(__dirname, "public", "logo.png"),
      path.join(__dirname, "public", "images", "logo.png"),
    ];
    const foundLogo = logoCandidates.find((p) => fs.existsSync(p));
    if (foundLogo) {
      console.log("✅ Logo found at:", foundLogo);
    } else {
      console.warn("⚠️  Logo not found. Place logo.png in assets/ folder.");
      console.warn("Searched paths:", logoCandidates);
    }

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
