const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, ".env") });
const { sendBroadcastNotification } = require("./services/notificationService");
const mongoose = require("mongoose");

// Parse terminal arguments or use defaults
// Usage: node send-notification.js "Title" "Body message" "image_url_optional" "collection_or_product_handle_optional"
const args = process.argv.slice(2);

const title = args[0] || "⚡ Flash Sale Alert!";
const body = args[1] || "Grab up to 50% OFF on all items! Limited time only.";
const imageUrl = args[2] || "";
const handle = args[3] || ""; // e.g. "lipstick" or "best-sellers"
const deepLinkType = handle ? "collection" : "home";

async function main() {
  console.log("\n🚀 Sending Flash Sale Notification...");
  console.log(`📌 Title: ${title}`);
  console.log(`📝 Body: ${body}`);
  if (imageUrl) console.log(`🖼️ Image: ${imageUrl}`);
  if (handle) console.log(`🔗 Link: ${deepLinkType} -> ${handle}`);
  console.log("----------------------------------------");

  // Connect Mongo if MONGO_URI exists (to store notification log for users)
  if (process.env.MONGO_URI) {
    try {
      await mongoose.connect(process.env.MONGO_URI);
      console.log(" Connected to Database");
    } catch (e) {
      console.warn("⚠️ Could not connect to DB, continuing with direct FCM...");
    }
  }

  try {
    const result = await sendBroadcastNotification({
      topic: "all",
      title,
      body,
      imageUrl,
      deepLinkType,
      deepLinkHandle: handle,
    });

    console.log("----------------------------------------");
    if (result.fcmMessageId) {
      console.log("✅ Notification successfully sent!");
      console.log(`📨 Message ID: ${result.fcmMessageId}`);
    } else {
      console.log("⚠️ Result:", result);
    }
  } catch (err) {
    console.error("❌ Failed to send notification:", err.message);
  } finally {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    process.exit(0);
  }
}

main();
