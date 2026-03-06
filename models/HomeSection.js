const mongoose = require("mongoose");

const ItemSchema = new mongoose.Schema({
  collectionId: String,
  title: String,
  image: String,
});

const HomeSectionSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
  },
  type: {
    type: String,
    required: true,
    enum: ["collection_grid", "banner", "product_slider"],
  },
  order: {
    type: Number,
    default: 0,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
  items: [ItemSchema],
}, { timestamps: true });

module.exports = mongoose.model("HomeSection", HomeSectionSchema);