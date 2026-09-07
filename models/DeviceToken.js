const mongoose = require("mongoose");

const deviceTokenSchema = new mongoose.Schema(
  {
    fcmToken: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
    },
    customerId: {
      type: String,
      trim: true,
      index: true,
      default: null,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      index: true,
      default: null,
    },
    phone: {
      type: String,
      trim: true,
      index: true,
      default: null,
    },
    platform: {
      type: String,
      enum: ["android", "ios", "web", "unknown"],
      default: "android",
    },
    appVersion: {
      type: String,
      default: "",
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    lastActiveAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

// Helper method to register or update a device token
deviceTokenSchema.statics.registerToken = async function ({
  fcmToken,
  customerId,
  email,
  phone,
  platform,
  appVersion,
}) {
  if (!fcmToken) return null;

  const updateData = {
    fcmToken: String(fcmToken).trim(),
    isActive: true,
    lastActiveAt: new Date(),
  };

  if (customerId) {
    const rawId = String(customerId).trim();
    const digits = rawId.replace(/\D/g, "");
    updateData.customerId = digits || rawId;
  }
  if (email) updateData.email = String(email).trim().toLowerCase();
  if (phone) {
    const digits = String(phone).replace(/[^\d]/g, "");
    updateData.phone = digits.length >= 10 ? digits.slice(-10) : digits;
  }
  if (platform) updateData.platform = platform.toLowerCase();
  if (appVersion) updateData.appVersion = appVersion;

  return this.findOneAndUpdate(
    { fcmToken: String(fcmToken).trim() },
    { $set: updateData },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
};

// Helper method to deactivate token on logout
deviceTokenSchema.statics.deactivateToken = async function (fcmToken) {
  if (!fcmToken) return null;
  return this.findOneAndUpdate(
    { fcmToken: String(fcmToken).trim() },
    { $set: { isActive: false, lastActiveAt: new Date() } }
  );
};

// Helper method to find active tokens for a customer by any identifier
deviceTokenSchema.statics.getActiveTokensForCustomer = async function ({
  customerId,
  email,
  phone,
}) {
  const conditions = [];

  if (customerId) {
    const rawId = String(customerId).trim();
    const digits = rawId.replace(/\D/g, "");
    conditions.push({ customerId: rawId });
    if (digits && digits !== rawId) {
      conditions.push({ customerId: digits });
    }
    if (digits) {
      conditions.push({ customerId: new RegExp(`${digits}$`) });
    }
  }

  if (email) {
    const cleanEmail = String(email).trim().toLowerCase();
    if (cleanEmail) {
      conditions.push({ email: cleanEmail });
    }
  }

  if (phone) {
    const cleanPhone = String(phone).replace(/[^\d]/g, "");
    if (cleanPhone) {
      conditions.push({ phone: String(phone).trim() });
      if (cleanPhone.length >= 10) {
        const last10 = cleanPhone.slice(-10);
        conditions.push({ phone: last10 });
        conditions.push({ phone: new RegExp(`${last10}$`) });
      }
    }
  }

  if (conditions.length === 0) return [];

  const records = await this.find({
    isActive: true,
    $or: conditions,
  }).select("fcmToken platform");

  return [...new Set(records.map((r) => r.fcmToken))];
};

module.exports = mongoose.model("DeviceToken", deviceTokenSchema);
