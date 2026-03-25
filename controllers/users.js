const User = require('../models/user');
const Listing = require('../models/listing');
const Profile = require('../models/profile');
const { admin } = require('../firebaseAdmin');

module.exports.renderSignupForm = async (req, res, next) => {
    res.render('users/signup.ejs');
}

module.exports.createSignup = async (req, res, next) => {
    try {
        let { username, email, password } = req.body;

        // 1. Register in Rentlyst (MongoDB)
        const newUser = new User({ username, email });
        const registeredUser = await User.register(newUser, password);
        const userId = registeredUser._id.toString();

        // 2. SYNC TO FIREBASE AUTH
        await admin.auth().createUser({
            uid: userId,
            email: email,
            password: password,
            displayName: username,
        });

        // 3. SYNC TO FIRESTORE "users"
        await admin.firestore().collection("users").doc(userId).set({
            username,
            email,
            id: userId,
            avatar: "",
            bio: "",
            blocked: [],
            createdAt: new Date() // Added this for your tracking
        });

        // 4. SYNC TO FIRESTORE "userchats"
        await admin.firestore().collection("userchats").doc(userId).set({
            chats: []
        });

        // 5. Create local Profile
        const newProfile = new Profile({
            user: registeredUser._id,
            username: registeredUser.username,
            email: registeredUser.email,
        });
        await newProfile.save();

        // --- NEW UPDATE: GENERATE TOKEN FOR AUTO-LOGIN ---
        // This generates the token for the user who was JUST created
        const firebaseToken = await admin.auth().createCustomToken(userId);

        // Drop the cookie so the React Nocap Chat can grab it
        res.cookie('fbToken', firebaseToken, {
            httpOnly: false,
            secure: false,
            maxAge: 7 * 24 * 60 * 60 * 1000 // 7 Days
        });
        // ------------------------------------------------

        req.login(registeredUser, (error) => {
            if (error) return next(error);
            req.flash("success", "Welcome! Your account and chat are ready.");
            return res.redirect('/listings');
        });

    } catch (e) {
        req.flash("error", "Signup/Sync Error: " + e.message);
        res.redirect('/signup');
    }
}
// Keep the rest of your login/logout logic as is for now...
module.exports.login = async (req, res) => {
    try {
        // 1. Generate a "Custom Token" for Firebase using the Mongo ID
        // This tells Firebase: "I've verified this user in MongoDB, let them in."
        const firebaseToken = await admin.auth().createCustomToken(req.user._id.toString());

        // 2. Set the token in a cookie named 'fbToken'
        // We set 'httpOnly: false' so React app's JavaScript can read it
        res.cookie('fbToken', firebaseToken, {
            httpOnly: false,
            secure: false, // Set to true only if using HTTPS
            maxAge: 7 * 24 * 60 * 60 * 1000 // Token lasts for 1 hour
        });

        // 3. Your original redirect logic
        req.flash("success", "Welcome back to Rentlyst!");
        const redirectUrl = req.session.returnTo || '/listings';
        delete req.session.returnTo;
        res.redirect(redirectUrl);

    } catch (error) {
        console.error("Firebase Token Error:", error);
        // Even if token fails, we let them into Rentlyst but show an error
        req.flash("error", "Rentlyst Login successful, but Chat sync failed.");
        res.redirect('/listings');
    }
}

module.exports.renderloginForm = async (req, res, next) => {
    res.render('users/login.ejs');
}

module.exports.logout = async (req, res, next) => {
    req.logout((error) => {
        if (error) return next(error);
        req.flash("success", "You are logged out!");
        res.redirect('/listings');
    });
}