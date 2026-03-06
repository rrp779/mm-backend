const express = require("express");
const router = express.Router();
const axios = require("axios");

// 🔐 Replace with your real values
const SHOP_DOMAIN = "makeup-mystery-india.myshopify.com";
const STOREFRONT_TOKEN = "dd608c57bca16ad54722334a67d5d521";

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