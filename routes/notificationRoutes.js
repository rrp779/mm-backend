const express = require("express");
const router = express.Router();
const DeviceToken = require("../models/DeviceToken");
const NotificationLog = require("../models/NotificationLog");
const { sendOrderNotification, sendBroadcastNotification } = require("../services/notificationService");

/**
 * Register or update device FCM token
 * POST /api/notifications/register-token
 * Body: { fcmToken, customerId, email, phone, platform, appVersion }
 */
router.post("/register-token", async (req, res) => {
  try {
    const { fcmToken, customerId, email, phone, platform, appVersion } = req.body;

    if (!fcmToken || typeof fcmToken !== "string" || !fcmToken.trim()) {
      return res.status(400).json({ error: "Valid fcmToken is required" });
    }

    const tokenDoc = await DeviceToken.registerToken({
      fcmToken: fcmToken.trim(),
      customerId,
      email,
      phone,
      platform: platform || "android",
      appVersion,
    });

    return res.status(200).json({
      success: true,
      message: "Device token registered successfully",
      deviceId: tokenDoc._id,
    });
  } catch (error) {
    console.error("[Notification Routes] Error registering token:", error);
    return res.status(500).json({ error: "Failed to register device token" });
  }
});

/**
 * Unregister device FCM token (e.g. on user logout)
 * POST /api/notifications/unregister-token
 * Body: { fcmToken }
 */
router.post("/unregister-token", async (req, res) => {
  try {
    const { fcmToken } = req.body;
    if (!fcmToken) {
      return res.status(400).json({ error: "fcmToken is required" });
    }

    await DeviceToken.deactivateToken(fcmToken.trim());

    return res.status(200).json({
      success: true,
      message: "Device token deactivated",
    });
  } catch (error) {
    console.error("[Notification Routes] Error deactivating token:", error);
    return res.status(500).json({ error: "Failed to unregister device token" });
  }
});

/**
 * Fetch notification history for a customer (including promotional broadcasts)
 * GET /api/notifications/history?phone=...&email=...
 */
router.get("/history", async (req, res) => {
  try {
    const { phone, email, customerId, limit = 50, page = 1 } = req.query;

    const queryConditions = [{ isBroadcast: true }];
    if (customerId) queryConditions.push({ customerId: String(customerId).trim() });
    if (email) queryConditions.push({ email: String(email).trim().toLowerCase() });
    if (phone) {
      const cleanPhone = String(phone).replace(/[^\d]/g, "");
      queryConditions.push({ phone: String(phone).trim() });
      if (cleanPhone.length >= 10) {
        queryConditions.push({ phone: { $regex: cleanPhone.slice(-10) + "$" } });
      }
    }

    const skip = (Math.max(1, parseInt(page, 10)) - 1) * parseInt(limit, 10);
    const notifications = await NotificationLog.find({ $or: queryConditions })
      .sort({ sentAt: -1 })
      .skip(skip)
      .limit(parseInt(limit, 10))
      .lean();

    return res.status(200).json({
      success: true,
      count: notifications.length,
      notifications,
    });
  } catch (error) {
    console.error("[Notification Routes] Error fetching history:", error);
    return res.status(500).json({ error: "Failed to fetch notification history" });
  }
});

/**
 * Broadcast promotional or flash sale notification to all users or topic subscribers
 * POST /api/notifications/broadcast
 * Body: {
 *   title: "⚡ Flash Sale: Flat 50% OFF!",
 *   body: "Hurry! Sale live for next 60 minutes only.",
 *   imageUrl: "https://...",
 *   topic: "promotions" | "flash_sales" | "all_users",
 *   type: "collection" | "product" | "cart",
 *   handle: "flash-deals",
 *   status: "flash_sale" | "promotional",
 *   discountCode: "FLASH50"
 * }
 */
router.post("/broadcast", async (req, res) => {
  try {
    const {
      title,
      body,
      imageUrl,
      topic = "promotions",
      type = "collection",
      handle = "",
      status = "flash_sale",
      discountCode,
    } = req.body;

    if (!title || !body) {
      return res.status(400).json({ error: "title and body are required for broadcast" });
    }

    const result = await sendBroadcastNotification({
      title,
      body,
      imageUrl,
      topic,
      status,
      deepLink: {
        type,
        handle,
        title,
      },
      additionalData: discountCode ? { discount_code: discountCode } : {},
    });

    return res.status(200).json({
      success: true,
      result,
    });
  } catch (error) {
    console.error("[Notification Routes] Error sending broadcast:", error);
    return res.status(500).json({ error: error.message });
  }
});

/**
 * Manual test endpoint for QA/Development to trigger test notifications
 * POST /api/notifications/test-send
 * Body: { orderId, orderNumber, status, phone, email, customerId }
 */
router.post("/test-send", async (req, res) => {
  try {
    const {
      orderId = "TEST_" + Date.now(),
      orderNumber = "#TEST",
      status = "order_placed",
      phone,
      email,
      customerId,
      title,
      body,
    } = req.body;

    const result = await sendOrderNotification({
      orderId,
      orderNumber,
      status,
      phone,
      email,
      customerId,
      customTitle: title,
      customBody: body,
    });

    return res.status(200).json({
      success: true,
      result,
    });
  } catch (error) {
    console.error("[Notification Routes] Error sending test notification:", error);
    return res.status(500).json({ error: error.message });
  }
});

/**
 * Delete a single notification
 * DELETE /api/notifications/:id
 */
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: "ID required" });
    await NotificationLog.findByIdAndDelete(id);
    return res.status(200).json({ success: true, message: "Notification deleted" });
  } catch (error) {
    console.error("[Notification Routes] Error deleting notification:", error);
    return res.status(500).json({ error: "Failed to delete notification" });
  }
});

/**
 * Clear all notifications for a customer
 * DELETE /api/notifications/clear/all
 */
router.delete("/clear/all", async (req, res) => {
  try {
    const phone = req.query.phone || req.body?.phone;
    const email = req.query.email || req.body?.email;
    const customerId = req.query.customerId || req.body?.customerId;

    const queryConditions = [];
    if (customerId) queryConditions.push({ customerId: String(customerId).trim() });
    if (email) queryConditions.push({ email: String(email).trim().toLowerCase() });
    if (phone) {
      const cleanPhone = String(phone).replace(/[^\d]/g, "");
      queryConditions.push({ phone: String(phone).trim() });
      if (cleanPhone.length >= 10) {
        queryConditions.push({ phone: { $regex: cleanPhone.slice(-10) + "$" } });
      }
    }

    if (queryConditions.length === 0) {
      return res.status(400).json({ error: "Customer identifier required to clear notifications" });
    }

    const result = await NotificationLog.deleteMany({ $or: queryConditions });
    return res.status(200).json({ success: true, deletedCount: result.deletedCount });
  } catch (error) {
    console.error("[Notification Routes] Error clearing notifications:", error);
    return res.status(500).json({ error: "Failed to clear notifications" });
  }
});

module.exports = router;
