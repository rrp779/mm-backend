const mongoose = require("mongoose");

const notificationLogSchema = new mongoose.Schema(
  {
    orderId: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },
    orderNumber: {
      type: String,
      trim: true,
      default: "",
    },
    status: {
      type: String,
      required: true,
      enum: [
        "order_placed",
        "order_confirmed",
        "order_shipped",
        "out_for_delivery",
        "order_delivered",
        "order_cancelled",
        "order_refunded",
        "payment_failed",
        "custom",
      ],
      index: true,
    },
    customerId: {
      type: String,
      trim: true,
      default: null,
    },
    email: {
      type: String,
      trim: true,
      default: null,
    },
    phone: {
      type: String,
      trim: true,
      default: null,
    },
    title: {
      type: String,
      required: true,
    },
    body: {
      type: String,
      required: true,
    },
    data: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    sentTokensCount: {
      type: Number,
      default: 0,
    },
    successTokensCount: {
      type: Number,
      default: 0,
    },
    failureTokensCount: {
      type: Number,
      default: 0,
    },
    sentAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

// Compound index to strictly enforce deduplication: one notification per order per status
notificationLogSchema.index({ orderId: 1, status: 1 }, { unique: true });

module.exports = mongoose.model("NotificationLog", notificationLogSchema);
