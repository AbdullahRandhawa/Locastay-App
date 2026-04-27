const admin = require("firebase-admin");
const fs = require("fs");
const dns = require("node:dns");
dns.setDefaultResultOrder('ipv4first'); // FIXES Node 20/22 IPv6 fetch errors with Google APIs

let serviceAccount;

try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        // 1. From environment variable (JSON string)
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } else if (fs.existsSync('/etc/secrets/firebase-service-account.json')) {
        // 2. From Render Secret File
        serviceAccount = require('/etc/secrets/firebase-service-account.json');
    } else {
        // 3. Local fallback
        serviceAccount = require("./config/firebase-service-account.json");
    }
} catch (error) {
    console.error("Error: Could not load Firebase credentials.");
    console.error("Please ensure either FIREBASE_SERVICE_ACCOUNT env var is set,");
    console.error("or a Render Secret File exists at /etc/secrets/firebase-service-account.json,");
    console.error("or ./config/firebase-service-account.json exists locally.");
    throw error;
}

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log("🚀 Firebase Admin initialized!");
}

const db = admin.firestore();
module.exports = { admin, db };