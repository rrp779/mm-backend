const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, ".env") });
const gokwikService = require("./services/gokwikService");

// Usage: node test-whatsapp.js <phone_number> e.g. node test-whatsapp.js 9876543210
const rawPhone = process.argv[2] || "9876543210";
const cleanPhone = rawPhone.replace(/\D/g, "");
const testOtp = "123456";

async function test() {
  console.log("=========================================");
  console.log("🧪 KwikEngage / GoKwik WhatsApp Test");
  console.log("=========================================");
  console.log(`📱 Destination Phone: +91${cleanPhone.slice(-10)}`);
  console.log(`🔑 Template ID: ${gokwikService.templateId}`);
  console.log(`🔐 OTP Code: ${testOtp}`);
  console.log("-----------------------------------------");

  const result = await gokwikService.sendOtp(`+91${cleanPhone.slice(-10)}`, testOtp);

  console.log("-----------------------------------------");
  if (result.success) {
    console.log("✅ SUCCESS! OTP WhatsApp message delivered.");
    console.log("Details:", JSON.stringify(result.data, null, 2));
  } else {
    console.log("❌ FAILED to send WhatsApp OTP.");
    console.log("Error:", result.error);
    if (result.details) console.log("Response Data:", JSON.stringify(result.details, null, 2));
  }
  console.log("=========================================");
}

test();
