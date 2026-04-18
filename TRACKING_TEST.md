# Task 4 — Tracking Test Checklist

## Prerequisites
- [ ] `SHIPROCKET_EMAIL` set in `.env`
- [ ] `SHIPROCKET_PASSWORD` set in `.env`
- [ ] Order in Shopify has a fulfillment with a real AWB tracking number
- [ ] That AWB is registered/trackable in Shiprocket

## Test Steps
1. Restart backend: `node server.js` (or `npm run dev`)
2. Call: `GET /api/order/{real_order_id}/tracking`
3. Verify response has:
   - [ ] `shiprocket_available: true`
   - [ ] `currentStatus` is not empty
   - [ ] `estimatedDelivery` is not null
   - [ ] `timeline` has correct `done` flags
   - [ ] `trackingEvents` has at least 1 event
4. Open Flutter app → go to Orders → tap an order → tap Track
5. Verify:
   - [ ] EDD shows formatted date (not "Calculating...")
   - [ ] Correct timeline step is highlighted
   - [ ] "View Details" expands with scan history
   - [ ] Live tracking button appears if URL exists

## Fallback (if Shiprocket unavailable)
- Response still returns Shopify data
- `shiprocket_available: false`
- EDD shows "Calculating..."
- Timeline uses Shopify fulfillment status only

