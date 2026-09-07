const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const { sendOrderNotification } = require("../services/notificationService");

/**
 * Verify Shopify Webhook HMAC Signature (Optional if secret configured)
 */
function verifyShopifyHmac(req) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) return true; // If not configured, proceed with warning

  const headerHmac = req.get("X-Shopify-Hmac-Sha256");
  if (!headerHmac) return false;

  const rawBody = req.rawBody || JSON.stringify(req.body);
  const hash = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64");

  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(headerHmac));
}

/**
 * Shopify Order Webhook
 * POST /api/webhooks/shopify/orders
 * Topic: orders/updated, orders/fulfilled, orders/cancelled
 */
router.post("/shopify/orders", async (req, res) => {
  try {
    const topic = req.get("X-Shopify-Topic") || "orders/updated";
    const order = req.body;

    if (!order || !order.id) {
      return res.status(400).json({ error: "Invalid order payload" });
    }

    const orderId = String(order.id);
    const orderNumber = order.name || String(order.order_number || order.id);
    const email = order.email || order.contact_email || "";
    const phone = order.phone || order.shipping_address?.phone || order.billing_address?.phone || "";
    const customerId = order.customer?.id ? String(order.customer.id) : null;

    console.log(`[Shopify Webhook] Received ${topic} for Order ${orderNumber} (${orderId})`);

    // 1. Order Cancelled
    if (topic === "orders/cancelled" || order.cancelled_at) {
      await sendOrderNotification({
        orderId,
        orderNumber,
        status: "order_cancelled",
        customerId,
        email,
        phone,
      });
      return res.status(200).json({ received: true, event: "order_cancelled" });
    }

    // 2. Order Fulfilled / Shipped
    if (topic === "orders/fulfilled" || order.fulfillment_status === "fulfilled") {
      await sendOrderNotification({
        orderId,
        orderNumber,
        status: "order_shipped",
        customerId,
        email,
        phone,
      });
      return res.status(200).json({ received: true, event: "order_shipped" });
    }

    // 3. Order Confirmed (Order created or updated with confirmed status)
    if (order.confirmed && order.financial_status === "paid") {
      await sendOrderNotification({
        orderId,
        orderNumber,
        status: "order_confirmed",
        customerId,
        email,
        phone,
      });
      return res.status(200).json({ received: true, event: "order_confirmed" });
    }

    return res.status(200).json({ received: true, processed: false, reason: "no_matching_event" });
  } catch (error) {
    console.error("[Shopify Order Webhook Error]:", error);
    return res.status(500).json({ error: "Webhook processing failed" });
  }
});

/**
 * Shopify Refund Webhook
 * POST /api/webhooks/shopify/refunds
 * Topic: refunds/create
 */
router.post("/shopify/refunds", async (req, res) => {
  try {
    const refund = req.body;
    const orderId = String(refund.order_id || "");

    if (!orderId) {
      return res.status(400).json({ error: "Invalid refund payload, missing order_id" });
    }

    console.log(`[Shopify Refund Webhook] Received refund for Order ID: ${orderId}`);

    await sendOrderNotification({
      orderId,
      status: "order_refunded",
      additionalData: {
        refund_id: String(refund.id || ""),
      },
    });

    return res.status(200).json({ received: true, event: "order_refunded" });
  } catch (error) {
    console.error("[Shopify Refund Webhook Error]:", error);
    return res.status(500).json({ error: "Refund webhook processing failed" });
  }
});

/**
 * Shiprocket Tracking Webhook
 * POST /api/webhooks/shiprocket/tracking
 * Triggered on courier status changes: OUT_FOR_DELIVERY, DELIVERED, SHIPPED
 */
router.post("/shiprocket/tracking", async (req, res) => {
  try {
    const payload = req.body;
    const currentStatus = String(payload.current_status || payload.status || "").toUpperCase();
    const orderId = String(payload.order_id || payload.channel_order_id || "");
    const awb = payload.awb || payload.awb_code;

    console.log(`[Shiprocket Webhook] Status: '${currentStatus}' for Order: ${orderId} (AWB: ${awb})`);

    if (!orderId) {
      return res.status(200).json({ received: true, note: "missing order_id, skipped" });
    }

    if (currentStatus.includes("OUT FOR DELIVERY") || currentStatus.includes("OUT_FOR_DELIVERY")) {
      await sendOrderNotification({
        orderId,
        status: "out_for_delivery",
        additionalData: { awb: String(awb || "") },
      });
    } else if (currentStatus.includes("DELIVERED")) {
      await sendOrderNotification({
        orderId,
        status: "order_delivered",
        additionalData: { awb: String(awb || "") },
      });
    } else if (currentStatus.includes("IN TRANSIT") || currentStatus.includes("SHIPPED")) {
      await sendOrderNotification({
        orderId,
        status: "order_shipped",
        additionalData: { awb: String(awb || "") },
      });
    }

    return res.status(200).json({ received: true, status: currentStatus });
  } catch (error) {
    console.error("[Shiprocket Webhook Error]:", error);
    return res.status(500).json({ error: "Tracking webhook processing failed" });
  }
});

module.exports = router;
