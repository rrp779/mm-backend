const mongoose = require("mongoose");
const { getMessagingInstance, isFirebaseReady } = require("../config/firebase");
const DeviceToken = require("../models/DeviceToken");
const NotificationLog = require("../models/NotificationLog");

// Configurable Notification Templates
const DEFAULT_TEMPLATES = {
  order_placed: {
    title: "Order Placed Successfully! 🎉",
    body: "Thank you for your order {{order_number}}! We're preparing it for you.",
  },
  order_confirmed: {
    title: "Order Confirmed ✅",
    body: "Your order {{order_number}} has been confirmed and is being processed.",
  },
  order_shipped: {
    title: "Your Order Has Shipped! 🚚",
    body: "Order {{order_number}} is on the way. Tap to track your package!",
  },
  out_for_delivery: {
    title: "Out for Delivery! 📦",
    body: "Get ready! Your order {{order_number}} will be delivered today.",
  },
  order_delivered: {
    title: "Order Delivered! 🎁",
    body: "Your order {{order_number}} has been delivered. Enjoy your beauty essentials!",
  },
  order_cancelled: {
    title: "Order Cancelled",
    body: "Your order {{order_number}} has been cancelled. Any payment made will be refunded.",
  },
  order_refunded: {
    title: "Refund Initiated 💳",
    body: "A refund for order {{order_number}} has been processed and will reflect in 5-7 business days.",
  },
  payment_failed: {
    title: "Payment Incomplete ⚠️",
    body: "Your payment could not be processed. Tap to retry or complete your checkout.",
  },
};

/**
 * Replace placeholders like {{order_number}} in template text
 */
function interpolate(template, params = {}) {
  let result = template || "";
  for (const [key, value] of Object.entries(params)) {
    result = result.replace(new RegExp(`{{${key}}}`, "g"), String(value ?? ""));
  }
  return result;
}

/**
 * Send an order status notification with automatic deduplication
 */
async function sendOrderNotification({
  orderId,
  orderNumber,
  status,
  customerId,
  email,
  phone,
  customTitle,
  customBody,
  additionalData = {},
}) {
  if (!orderId || !status) {
    console.warn("[Notification Service] Missing orderId or status for notification.");
    return { success: false, error: "Missing orderId or status" };
  }

  const cleanOrderId = String(orderId).trim();
  const cleanOrderNumber = String(orderNumber || cleanOrderId).trim();

  // 1. Deduplication Check (Strict idempotency for order lifecycle events)
  const existingLog = await NotificationLog.findOne({
    orderId: cleanOrderId,
    status: status,
  });

  if (existingLog) {
    console.log(
      `[Notification Service] ⏭️ Skipped duplicate notification for Order: ${cleanOrderId}, Status: ${status}`
    );
    return {
      success: true,
      skipped: true,
      reason: "duplicate",
      logId: existingLog._id,
    };
  }

  // 2. Resolve Title and Body
  const template = DEFAULT_TEMPLATES[status] || {
    title: "Order Update",
    body: "There is an update on your order {{order_number}}.",
  };

  const title = customTitle || interpolate(template.title, { order_number: cleanOrderNumber });
  const body = customBody || interpolate(template.body, { order_number: cleanOrderNumber });

  // 3. Fallback recovery for customer identifiers if missing (e.g. from webhooks)
  let targetCustomerId = customerId;
  let targetEmail = email;
  let targetPhone = phone;

  if (!targetCustomerId && !targetEmail && !targetPhone) {
    try {
      const Order = mongoose.models.Order;
      if (Order) {
        const matched = await Order.findOne({
          $or: [
            { shopify_order_id: cleanOrderId },
            { shopify_order_number: cleanOrderId },
            { shopify_order_number: `#${cleanOrderId.replace(/^#/, "")}` },
            { razorpay_order_id: cleanOrderId },
          ],
        }).lean();
        if (matched) {
          targetEmail = matched.email;
          targetPhone = matched.phone;
        }
      }
      if (!targetEmail && !targetPhone) {
        const prevLog = await NotificationLog.findOne({ orderId: cleanOrderId }).lean();
        if (prevLog) {
          targetCustomerId = prevLog.customerId;
          targetEmail = prevLog.email;
          targetPhone = prevLog.phone;
        }
      }
    } catch (recoverErr) {
      console.warn("[Notification Service] Customer identifier recovery note:", recoverErr.message);
    }
  }

  // Find active FCM tokens for this customer
  const tokens = await DeviceToken.getActiveTokensForCustomer({
    customerId: targetCustomerId,
    email: targetEmail,
    phone: targetPhone,
  });

  // Prepare standard payload for deep-linking
  const dataPayload = {
    type: status === "payment_failed" ? "cart" : "order",
    order_id: cleanOrderId,
    order_number: cleanOrderNumber,
    status: status,
    click_action: "FLUTTER_NOTIFICATION_CLICK",
    ...Object.fromEntries(
      Object.entries(additionalData).map(([k, v]) => [k, String(v ?? "")])
    ),
  };

  let sentCount = tokens.length;
  let successCount = 0;
  let failureCount = 0;
  let fcmMessageId = null;

  const messaging = getMessagingInstance();

  // 4. Send via Firebase Admin if tokens exist and Firebase is ready
  if (tokens.length > 0 && isFirebaseReady() && messaging) {
    try {
      const message = {
        tokens,
        notification: {
          title,
          body,
        },
        data: dataPayload,
        android: {
          priority: "high",
          notification: {
            channelId: "order_updates_channel",
            sound: "default",
          },
        },
        apns: {
          payload: {
            aps: {
              sound: "default",
              badge: 1,
            },
          },
        },
      };

      const response = await messaging.sendEachForMulticast(message);
      successCount = response.successCount;
      failureCount = response.failureCount;

      console.log(
        `[Notification Service] 📲 Sent '${status}' notification to ${successCount}/${tokens.length} devices for Order ${cleanOrderNumber}`
      );

      // Clean up dead/invalid tokens
      if (response.failureCount > 0) {
        response.responses.forEach(async (resp, idx) => {
          if (!resp.success) {
            const errCode = resp.error?.code;
            if (
              errCode === "messaging/invalid-registration-token" ||
              errCode === "messaging/registration-token-not-registered"
            ) {
              const deadToken = tokens[idx];
              await DeviceToken.deactivateToken(deadToken);
              console.log(`[Notification Service] Deactivated stale token: ${deadToken.slice(0, 15)}...`);
            }
          }
        });
      }
    } catch (sendErr) {
      console.error("[Notification Service] Error sending FCM message:", sendErr.message);
    }
  } else {
    // If no tokens or Firebase credentials not yet added, log clearly in Mock Mode
    if (tokens.length === 0) {
      console.log(
        `[Notification Service] ℹ️ No registered devices found for customer (Phone: ${phone}, Email: ${email}). Notification logged.`
      );
    } else {
      console.log(
        `[Notification Service] 🔔 [MOCK PUSH SENT] Title: "${title}" | Body: "${body}" | Devices: ${tokens.length}`
      );
      successCount = tokens.length;
    }
  }

  // 5. Record in NotificationLog to ensure idempotency & audit trail
  try {
    const logEntry = await NotificationLog.create({
      orderId: cleanOrderId,
      orderNumber: cleanOrderNumber,
      status: status,
      customerId: customerId ? String(customerId) : null,
      email: email ? String(email).toLowerCase() : null,
      phone: phone ? String(phone) : null,
      title,
      body,
      data: dataPayload,
      sentTokensCount: sentCount,
      successTokensCount: successCount,
      failureTokensCount: failureCount,
      sentAt: new Date(),
    });

    return {
      success: true,
      logId: logEntry._id,
      title,
      body,
      sentCount,
      successCount,
    };
  } catch (logErr) {
    console.error("[Notification Service] Error creating notification log:", logErr.message);
    return { success: true, warning: "Log creation failed" };
  }
}

module.exports = {
  sendOrderNotification,
  DEFAULT_TEMPLATES,
};
