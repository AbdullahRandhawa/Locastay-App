const mongoose = require('mongoose');
const initData = require('./data.js');
const Listing = require('../models/listing.js');

//DataBase Connection
main()
    .then(() => {
        console.log("Connection Successful to DB");
    })
    .catch((err) => {
        console.log("Connection Failed to DB");
    });

async function main() {
    await mongoose.connect('mongodb://127.0.0.1:27017/locastay');
}


// const newData = async () => {
//     // await Listing.deleteMany({});
//     initData.data = initData.data.map((obj) => ({ ...obj, owner: '68c6a9cce1134e995501a789' }))
//     await Listing.insertMany(initData.data);
//     console.log("Data Has Been Initialized.");
// };

// newData();

