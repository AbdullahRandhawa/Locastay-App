// Suppress DEP0044 warning globally for outdated dependencies
const util = require('util');
util.isArray = Array.isArray;

if (process.env.NODE_ENV != "production") {
    require("dotenv").config();
}
const express = require('express');
const app = express();
const mongoose = require('mongoose');
const path = require('path');
const methodOverride = require('method-override');
const ejsMate = require("ejs-mate");
const Listing = require('./models/listing.js');
const ExpressError = require('./utils/ExpressError');
const { isLoggedIn, isOwner, validateListing, validateReview } = require('./utils/middleware');

const cookieParser = require('cookie-parser');
const session = require('express-session');
const MongoStore = require('connect-mongo');

const flash = require('connect-flash');
const Profile = require('./models/profile');


const exploreRoute = require('./routes/explore.js');
const reviewRoute = require('./routes/review.js');
const userRoute = require('./routes/user.js');
const profileRouter = require("./routes/profile.js");
const adminRouter = require('./routes/admin.js');
const agentRoute = require('./routes/agent.js');

const homeRoute = require('./routes/home.js');
const User = require("./models/user.js");
const asyncWrap = require("./utils/asyncWrap.js");

const ATLAS_URL = process.env.ATLASDB_URL;


//DataBase Connection------------------------------
main()
    .then(() => {
        console.log("Connection Successful to DB");
    })
    .catch((err) => {
        console.log("Connection Failed to DB");
    });

async function main() {
    // mongoose.connect('mongodb://127.0.0.1:27017/rentlyst');
    mongoose.connect(ATLAS_URL);

}


const store = MongoStore.create({
    mongoUrl: ATLAS_URL,
    crypto: {
        secret: process.env.SECRET,
    },
    touchAfter: 24 * 3600,
})

store.on("error", (err) => {
    console.log("Error in Mongo session store", err);
});


const sessionOpentions = {
    store,
    secret: process.env.SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: {
        expires: Date.now() + 60 * 24 * 60 * 60 * 1000,
        maxAge: 60 * 24 * 60 * 60 * 1000,
        httpOnly: true,
    },
}








app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"))
//Middlewares-------------------------------------------
app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: true }));
app.use(methodOverride('_method'));
app.engine("ejs", ejsMate);
app.use(express.json());
app.use(cookieParser('secretkay'));
app.use(session(sessionOpentions));
app.use(flash());



const { admin } = require('./firebaseAdmin');

app.use(async (req, res, next) => {
    // 🔥 NEW: Global Firebase Session Check
    const sessionCookie = req.cookies.__session || '';
    req.user = null; // Default to null
    
    if (sessionCookie) {
        try {
            const decodedClaims = await admin.auth().verifySessionCookie(sessionCookie, true);
            const user = await User.findOne({ firebaseUid: decodedClaims.uid });
            if (user) {
                req.user = user;
            }
        } catch (err) {
            // Silently ignore expired/invalid cookies on public routes
        }
    }

    res.locals.success = req.flash('success');
    res.locals.error = req.flash('error');
    res.locals.currUser = req.user;
    
    // Fetch profile for navbar avatar
    if (req.user) {
        try {
            const profile = await Profile.findOne({ user: req.user._id }).lean();
            res.locals.currProfile = profile;
        } catch (e) {
            console.error('Error fetching global profile:', e);
            res.locals.currProfile = null;
        }
    } else {
        res.locals.currProfile = null;
    }
    
    next();
});


app.use('/', homeRoute);
app.use('/explore', exploreRoute);
app.use('/explore/:id/reviews', reviewRoute);
app.use('/', userRoute);
app.use('/agent', agentRoute);
app.use('/profile', profileRouter);
app.use('/admin', adminRouter);

const multer = require('multer');
const { storage, cloudinary } = require('./cloudConfig.js');
const { profile } = require("console");
const upload = multer({ storage });




// 404 Not Found Catch-All Handler /Middleware-----
app.use((req, res, next) => {
    next(new ExpressError(404, "Page not found!"));
});



// Err Middleware---------------------------------------------
app.use((err, req, res, next) => {
    let { status = 500, message = "Some thing went wrong!" } = err;
    res.status(status).render("error.ejs", { message });
});


// Listining Port--------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});