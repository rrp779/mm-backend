const axios = require("axios");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

/**
 * KwikEngage (GoKwik) WhatsApp Messaging & OTP Service
 * API Docs: https://api.kwikengage.ai/send-message/v2
 */
class GoKwikService {
  constructor() {
    this.apiUrl = "https://api.kwikengage.ai/send-message/v2";
  }

  get apiKey() {
    return process.env.GOKWIK_API_KEY || process.env.KWIKENGAGE_API_KEY || process.env.GOKWIK_APP_SECRET || "";
  }

  get merchantId() {
    return process.env.GOKWIK_MERCHANT_ID || process.env.KWIKENGAGE_MERCHANT_ID || "";
  }

  get templateId() {
    return process.env.GOKWIK_OTP_TEMPLATE || process.env.KWIKENGAGE_OTP_TEMPLATE || "otp_login";
  }

  get language() {
    return process.env.GOKWIK_LANGUAGE || "en";
  }


  isConfigured() {
    return Boolean(this.apiKey || process.env.GOKWIK_APP_SECRET);
  }

  getAuthHeader() {
    const key = (this.apiKey || process.env.GOKWIK_APP_SECRET || "").trim();
    // Some KwikEngage endpoints expect raw token or Bearer
    return key.startsWith("Bearer ") ? key : key;
  }


  /**
   * Send WhatsApp OTP Template via KwikEngage API
   * @param {string} phone e.g. +919876543210
   * @param {string} otp e.g. "123456"
   */
  async sendOtp(phone, otp) {
    if (!this.isConfigured()) {
      console.warn("[KwikEngage] API Key not configured in .env.");
      return { success: false, fallback: true, error: "KwikEngage credentials not configured" };
    }

    // Format phone: 919876543210 (without +)
    const cleanPhone = phone.replace(/^\+/, "");

    const payload = {
      to: cleanPhone,
      channel: "whatsapp",
      content: {
        type: "template",
        template: {
          template_id: this.templateId,
          language: this.language,
          components: [
            {
              type: "body",
              parameters: [
                {
                  type: "text",
                  text: String(otp),
                },
              ],
            },
            {
              type: "button",
              sub_type: "otp",
              index: 0,
              parameters: [
                {
                  type: "text",
                  text: String(otp),
                },
              ],
            },
          ],
        },
      },
    };


    try {
      console.log(`[KwikEngage] Sending WhatsApp OTP to ${cleanPhone} using template '${this.templateId}'...`);
      const response = await axios.post(this.apiUrl, payload, {
        headers: {
          "Content-Type": "application/json",
          "Authorization": this.getAuthHeader(),
        },
        timeout: 12000,
      });

      console.log(`[KwikEngage] ✅ OTP sent successfully:`, response.data);
      return {
        success: true,
        data: response.data,
      };
    } catch (error) {
      const errMsg = error.response?.data?.message || error.response?.data?.error || error.message;
      console.error("[KwikEngage] ❌ Send OTP Error:", errMsg, error.response?.data);
      return {
        success: false,
        error: errMsg,
        details: error.response?.data,
      };
    }
  }
}

module.exports = new GoKwikService();
