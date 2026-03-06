const express = require("express");
const router = express.Router();
const HomeSection = require("../models/HomeSection");

// GET all sections
router.get("/", async (req, res) => {
  try {
    const sections = await HomeSection.find().sort({ order: 1 });
    res.json(sections);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// CREATE section
router.post("/", async (req, res) => {
  try {
    const section = await HomeSection.create(req.body);
    res.json(section);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// UPDATE SECTION
router.put("/:id", async (req, res) => {
  try {
    const updated = await Section.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true }
    );
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE section
router.delete("/:id", async (req, res) => {
  try {
    await HomeSection.findByIdAndDelete(req.params.id);
    res.json({ message: "Deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;