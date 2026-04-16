const joi = require('joi');
const CATEGORIES = require('./utils/categories'); // Importing the source of truth

// Extract all valid subcategories for validation
const allSubCats = Object.values(CATEGORIES).flat();

module.exports.listingSchema = joi.object({
    listing: joi.object({
        title: joi.string().required().max(100),
        description: joi.string().required(),
        price: joi.number().required().min(0),

        // Updated Fields
        city: joi.string().required(), // Renamed from location
        country: joi.string().required(),
        address: joi.string().required(), // New required field for Mapbox

        // Marketplace Categorization
        mainCategory: joi.string().required().valid(...Object.keys(CATEGORIES)),
        subCategory: joi.string().required().valid(...allSubCats),

        // Rental & Condition
        listingType: joi.string().required().valid('Sale', 'Rent'),
        rentalPeriod: joi.string().valid('hour', 'day', 'week', 'month', 'flat', 'N/A').required(),
        conditionGrade: joi.number().min(1).max(10).optional(),

        // Dynamic Specifications (Optional because they vary by category)
        specifications: joi.object({
            make: joi.string().allow('', null),
            model: joi.string().allow('', null),
            year: joi.number().integer().min(1900).max(2026).allow(null),
            area: joi.string().allow('', null),
            bedrooms: joi.number().integer().min(0).allow(null),
            bathrooms: joi.number().integer().min(0).allow(null),
            brand: joi.string().allow('', null),
            experience: joi.string().allow('', null),
            portfolioLink: joi.string().uri().allow('', null),
            serviceLocation: joi.string().valid('Online', 'On-site', 'On-site & Online').allow('', null)
        }).optional(),

        // Image validation is handled differently since Multer handles the upload,
        // but we leave this here for safety if you pass existing URLs.
        image: joi.array().items(
            joi.object({
                filename: joi.string().allow('', null),
                url: joi.string().allow('', null)
            })
        ).optional()
    }).required()
});

module.exports.reviewSchema = joi.object({
    review: joi.object({
        comment: joi.string().required(),
        rating: joi.number().required().min(1).max(5),
    }).required()
});