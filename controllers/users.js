const User = require('../models/user');
const Listing = require('../models/listing');
const Profile = require('../models/profile');
const { admin } = require('../firebaseAdmin');

// ─── SIGNUP ──────────────────────────────────────────────────────────────────
// The browser uses the Firebase SDK to create the account in Firebase first,
// then sends us the ID token. We verify it and create the Mongo record.
module.exports.renderSignupForm = async (req, res, next) => {
    res.render('users/signup.ejs', { hideFooter: true });
}

module.exports.createSignup = async (req, res, next) => {
    try {
        const { idToken, username } = req.body;

        // 1. Verify the Firebase ID token the browser sent us
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        const { uid: firebaseUid, email } = decodedToken;

        // 2. PRE-CHECK: Make sure username is not already used in MongoDB
        const existingUser = await User.findOne({
            $or: [{ username }, { email }]
        });
        if (existingUser) {
            // Clean up the Firebase account we just created since we can't complete registration
            await admin.auth().deleteUser(firebaseUid);
            return res.status(400).json({ error: 'Username or Email is already taken. Please try another.' });
        }

        // 3. Determine role — username1 is always the Admin
        const role = (username === 'username1') ? 'admin' : 'user';

        // 4. Create the Mongo User record (lightweight, no passwords)
        const newUser = await User.create({ firebaseUid, email, username, role });

        // 5. Sync to Firebase display name
        await admin.auth().updateUser(firebaseUid, { displayName: username });

        // 6. Sync to Firestore "users" (for Nocap-chat)
        await admin.firestore().collection("users").doc(firebaseUid).set({
            username,
            email,
            id: firebaseUid,
            avatar: "",
            bio: "",
            fullName: "",
            blocked: [],
            createdAt: new Date()
        });

        // 7. Sync to Firestore "userchats" (for Nocap-chat)
        await admin.firestore().collection("userchats").doc(firebaseUid).set({
            chats: []
        });

        // 8. Create local Profile document
        const newProfile = new Profile({
            user: newUser._id,
            username: newUser.username,
            email: newUser.email,
        });
        await newProfile.save();

        // 9. Create a Firebase Session Cookie (14 days - Firebase upper limit) to log them in securely
        const expiresIn = 60 * 60 * 24 * 14 * 1000; // 14 days in milliseconds
        const sessionCookie = await admin.auth().createSessionCookie(idToken, { expiresIn });

        res.cookie('__session', sessionCookie, {
            maxAge: expiresIn,
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
        });

        // 10. Nocap-chat custom token (for the messages iframe)
        const fbToken = await admin.auth().createCustomToken(firebaseUid);
        res.cookie('fbToken', fbToken, {
            httpOnly: false,
            secure: process.env.NODE_ENV === 'production',
            maxAge: 7 * 24 * 60 * 60 * 1000
        });

        req.flash("success", "Welcome! Your account is ready.");
        return res.status(200).json({ redirect: '/listings' });

    } catch (e) {
        console.error("Signup Error:", e);
        return res.status(500).json({ error: e.message || "Signup failed." });
    }
}

// ─── LOGIN ────────────────────────────────────────────────────────────────────
// The browser uses the Firebase SDK to sign in, gets an ID token,
// and sends it here. We verify it and create a secure session cookie.
module.exports.renderloginForm = async (req, res, next) => {
    res.render('users/login.ejs', { hideFooter: true });
}

module.exports.login = async (req, res) => {
    try {
        const { idToken } = req.body;

        // 1. Verify the ID token
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        const { uid: firebaseUid } = decodedToken;

        // 2. Find the matching Mongo user
        const user = await User.findOne({ firebaseUid });
        if (!user) {
            return res.status(404).json({ error: 'No Rentlyst account found. Please sign up first.' });
        }

        // 3. Create a secure Session Cookie (14 days - Firebase max allowed limit)
        const expiresIn = 60 * 60 * 24 * 14 * 1000;
        const sessionCookie = await admin.auth().createSessionCookie(idToken, { expiresIn });

        res.cookie('__session', sessionCookie, {
            maxAge: expiresIn,
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
        });

        // 4. Nocap-chat custom token (for the messages iframe)
        const fbToken = await admin.auth().createCustomToken(firebaseUid);
        res.cookie('fbToken', fbToken, {
            httpOnly: false,
            secure: process.env.NODE_ENV === 'production',
            maxAge: 7 * 24 * 60 * 60 * 1000
        });

        req.flash("success", "Welcome back to Rentlyst!");
        const redirectUrl = req.session.returnTo || '/listings';
        delete req.session.returnTo;
        return res.status(200).json({ redirect: redirectUrl });

    } catch (error) {
        console.error("Login Error:", error);
        return res.status(401).json({ error: 'Invalid credentials. Please try again.' });
    }
}

// ─── LOGOUT ───────────────────────────────────────────────────────────────────
module.exports.logout = async (req, res, next) => {
    res.clearCookie('__session');
    res.clearCookie('fbToken');
    req.flash("success", "You are logged out!");
    res.redirect('/listings');
}

// ─── UTILS ────────────────────────────────────────────────────────────────────
module.exports.resolveEmail = async (req, res) => {
    try {
        const { username } = req.body;
        if (!username) return res.status(400).json({ error: 'Username is required.' });

        const user = await User.findOne({ username });
        if (!user) {
            return res.status(404).json({ error: 'No account found with that username.' });
        }
        return res.status(200).json({ email: user.email });
    } catch (e) {
        console.error("Resolve email error: ", e);
        return res.status(500).json({ error: 'Server error looking up username.' });
    }
}