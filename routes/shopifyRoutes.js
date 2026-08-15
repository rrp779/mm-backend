const express = require("express");
const router = express.Router();
const axios = require("axios");

// 🔐 Replace with your real values
const SHOP_DOMAIN = "makeup-mystery-india.myshopify.com";
const STOREFRONT_TOKEN = "96a8a304c6865dbb9cd20edac41e275d";

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