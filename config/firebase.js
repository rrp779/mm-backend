const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getMessaging } = require("firebase-admin/messaging");
const fs = require("fs");
const path = require("path");

let isInitialized = false;
let messaging = null;

function initFirebase() {
  if (isInitialized && messaging) return messaging;

  try {
    let credentialCert = null;

    // 1. Try reading from FIREBASE_SERVICE_ACCOUNT_JSON env variable (Ideal for Railway / Cloud)
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
      credentialCert = cert(serviceAccount);
      console.log("✅ Using Firebase credentials from FIREBASE_SERVICE_ACCOUNT_JSON");
    } else if (
      process.env.FIREBASE_PROJECT_ID &&
      process.env.FIREBASE_CLIENT_EMAIL &&
      process.env.FIREBASE_PRIVATE_KEY
    ) {
      // 2. Try individual environment variables
      credentialCert = cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      });
      console.log("✅ Using Firebase credentials from individual env variables");
    } else {
      // 3. Try reading local service account JSON file
      const localFilePath = path.join(__dirname, "../firebase-service-account.json");
      if (fs.existsSync(localFilePath)) {
        const serviceAccount = JSON.parse(fs.readFileSync(localFilePath, "utf8"));
        credentialCert = cert(serviceAccount);
        console.log("✅ Using Firebase credentials from local firebase-service-account.json");
      }
    }

    if (!credentialCert) {
      console.warn(
        "⚠️ [Firebase Admin]: No service account credentials found. Push notifications will be logged to console in Mock Mode until credentials are added."
      );
      return null;
    }

    const app = getApps().length === 0 ? initializeApp({ credential: credentialCert }) : getApps()[0];
    messaging = getMessaging(app);
    isInitialized = true;
    console.log("✅ Firebase Admin Messaging initialized successfully");
    return messaging;
  } catch (error) {
    console.error("❌ [Firebase Admin Init Error]:", error.message);
    return null;
  }
}

const firebaseMessaging = initFirebase();

module.exports = {
  getMessagingInstance: () => firebaseMessaging || initFirebase(),
  isFirebaseReady: () => isInitialized,
};
