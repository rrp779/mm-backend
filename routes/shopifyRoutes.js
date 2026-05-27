const express = require("express");
const router = express.Router();
const axios = require("axios");

// 🔐 Replace with your real values
const SHOP_DOMAIN = "makeup-mystery-india.myshopify.com";
const STOREFRONT_TOKEN = "6d1ee35c574a5b42ea8abafcb1e8f3e5";

router.get("/collections", async (req, res) => {
  try {
    const response = await axios.post(
      `https://${SHOP_DOMAIN}/api/2023-10/graphql.json`,
      {
        query: `
          {
            collections(first: 20) {
              edges {
                node {
                  id
                  title
                  image {
                    url
                  }
                }
              }
            }
          }
        `,
      },
      {
        headers: {
          "X-Shopify-Storefront-Access-Token": STOREFRONT_TOKEN,
          "Content-Type": "application/json",
        },
      }
    );

    const collections =
      response.data.data.collections.edges.map(e => e.node);

    res.json(collections);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;