const Stripe = require("stripe");

let instance = null;

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY is not set");
  }
  if (!instance) {
    instance = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return instance;
}

function isStripeConfigured() {
  return Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY.length > 0);
}

module.exports = {
  getStripe,
  isStripeConfigured,
};
