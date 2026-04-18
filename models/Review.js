const mongoose = require("mongoose");

const ReviewSchema = new mongoose.Schema(
  {
    productId: { type: String, required: true, index: true }, // numeric id or gid
    rating: { type: Number, required: true, min: 1, max: 5 },
    body: { type: String, required: true, trim: true, maxlength: 4000 },
    reviewer: {
      name: { type: String, required: true, trim: true, maxlength: 120 },
      email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Review", ReviewSchema);

