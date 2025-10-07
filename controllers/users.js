const User = require('../models/user');
const Listing = require('../models/listing');
const Profile = require('../models/profile');


module.exports.renderSignupForm = async (req, res, next) => {
    res.render('users/signup.ejs');
}


module.exports.createSignup = async (req, res, next) => {
    try {
        let { username, email, password } = req.body;
        const newUser = new User({
            username: username,
            email: email,
        });
        const registeredUser = await User.register(newUser, password);

        const newProfile = new Profile({
            user: registeredUser._id,
            username: registeredUser.username,
            email: registeredUser.email,
        });
        const newp = await newProfile.save();


        req.login(registeredUser, (error) => {
            if (error) {
                return next(error);
            }
            req.flash("success", "Welcom to LocaStay!");
            return res.redirect('/listings');
        });
    } catch (e) {
        req.flash("error", e.message);
        res.redirect('/signup');
    }

}


module.exports.login = (req, res) => {
    req.flash("success", "Welcom back to LocaStay!")
    const redirectUrl = req.session.returnTo || '/listings';
    delete req.session.returnTo;
    res.redirect(redirectUrl);
}


module.exports.renderloginForm = async (req, res, next) => {
    res.render('users/login.ejs');
}


module.exports.logout = async (req, res, next) => {
    req.logout((error) => {
        if (error) {
            return next(error);
        }
        req.flash("success", "You are logged out!");
        res.redirect('/listings');
    });

}



