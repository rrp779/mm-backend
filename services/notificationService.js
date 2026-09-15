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

/**
 * Send broadcast / promotional push notification to an FCM topic
 * @param {Object} params
 * @param {string} params.title - Notification headline (e.g. "⚡ 1-HOUR FLASH SALE!")
 * @param {string} params.body - Notification body
 * @param {string} [params.imageUrl] - Big picture banner URL for notification drawer
 * @param {string} [params.topic="promotions"] - Target FCM topic ('all_users', 'promotions', 'flash_sales')
 * @param {string} [params.status="flash_sale"] - 'flash_sale' or 'promotional'
 * @param {Object} [params.deepLink] - { type: 'collection'|'product'|'cart', handle: string, title: string }
 * @param {Object} [params.additionalData] - Extra metadata key-values
 */
async function sendBroadcastNotification({
  title,
  body,
  imageUrl,
  topic = "promotions",
  status = "flash_sale",
  deepLink = {},
  additionalData = {},
}) {
  if (!title || !body) {
    throw new Error("title and body are required for broadcast notification");
  }

  const cleanTitle = String(title).trim();
  const cleanBody = String(body).trim();
  const cleanTopic = String(topic || "promotions").trim().replace(/[^a-zA-Z0-9-_.~%]/g, "_");
  const cleanImageUrl = imageUrl && typeof imageUrl === "string" && imageUrl.trim() ? imageUrl.trim() : null;

  const deepLinkType = String(deepLink.type || additionalData.type || "collection").toLowerCase();
  const deepLinkHandle = String(deepLink.handle || additionalData.handle || "");
  const deepLinkTitle = String(deepLink.title || additionalData.title || cleanTitle);

  const dataPayload = {
    type: deepLinkType,
    handle: deepLinkHandle,
    title: deepLinkTitle,
    status: status,
    is_broadcast: "true",
    topic: cleanTopic,
    image_url: cleanImageUrl || "",
    click_action: "FLUTTER_NOTIFICATION_CLICK",
    ...Object.fromEntries(
      Object.entries(additionalData).map(([k, v]) => [k, String(v ?? "")])
    ),
  };

  const notificationPayload = {
    title: cleanTitle,
    body: cleanBody,
  };
  if (cleanImageUrl) {
    notificationPayload.imageUrl = cleanImageUrl;
  }

  const fcmMessage = {
    topic: cleanTopic,
    notification: notificationPayload,
    data: dataPayload,
    android: {
      priority: "high",
      notification: {
        channelId: "high_importance_channel",
        priority: "max",
        defaultSound: true,
        ...(cleanImageUrl ? { imageUrl: cleanImageUrl } : {}),
      },
    },
    apns: {
      headers: {
        "apns-priority": "10",
      },
      payload: {
        aps: {
          alert: {
            title: cleanTitle,
            body: cleanBody,
          },
          sound: "default",
          badge: 1,
          mutableContent: true,
        },
      },
      ...(cleanImageUrl
        ? {
            fcmOptions: {
              imageUrl: cleanImageUrl,
            },
          }
        : {}),
    },
  };

  let fcmMessageId = null;
  let success = false;
  const messaging = getMessagingInstance();

  if (isFirebaseReady() && messaging) {
    try {
      fcmMessageId = await messaging.send(fcmMessage);
      success = true;
      console.log(`[Notification Service] 📢 Broadcast sent to topic '${cleanTopic}':`, fcmMessageId);
    } catch (fcmErr) {
      console.error(`[Notification Service] ❌ FCM Broadcast Error for topic '${cleanTopic}':`, fcmErr.message);
    }
  } else {
    console.warn(`[Notification Service] ⚠️ Firebase not ready, logging broadcast locally`);
  }

  // Save in MongoDB NotificationLog as broadcast so it appears in users' Notification Center
  try {
    const broadcastId = `PROMO_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const logEntry = await NotificationLog.create({
      orderId: broadcastId,
      orderNumber: deepLinkType === "collection" ? (deepLinkHandle || "PROMO") : "PROMO",
      status: status,
      isBroadcast: true,
      topic: cleanTopic,
      imageUrl: cleanImageUrl,
      title: cleanTitle,
      body: cleanBody,
      data: dataPayload,
      sentTokensCount: 1,
      successTokensCount: success ? 1 : 0,
      failureTokensCount: success ? 0 : 1,
      sentAt: new Date(),
    });

    return {
      success: true,
      broadcastId,
      logId: logEntry._id,
      topic: cleanTopic,
      fcmMessageId,
      title: cleanTitle,
      body: cleanBody,
      imageUrl: cleanImageUrl,
    };
  } catch (logErr) {
    console.error("[Notification Service] Error creating broadcast log:", logErr.message);
    return {
      success: true,
      warning: "Log creation failed",
      topic: cleanTopic,
      fcmMessageId,
    };
  }
}

module.exports = {
  sendOrderNotification,
  sendBroadcastNotification,
  DEFAULT_TEMPLATES,
};
