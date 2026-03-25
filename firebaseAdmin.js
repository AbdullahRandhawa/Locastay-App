const admin = require("firebase-admin");
const serviceAccount = require("./config/firebase-service-account.json");

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log("🚀 Firebase Admin initialized!");
}

const db = admin.firestore();
module.exports = { admin, db };