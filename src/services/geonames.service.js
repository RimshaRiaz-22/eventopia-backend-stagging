const GeoNames = require("geonames.js");

const geonames = new GeoNames({
  username: process.env.GEONAMES_USERNAME,
  lan: "en",
});


/**
 * Search for cities by name
 */
async function searchCities(query, country = "GB", maxRows = 10) {
  try {
    const result = await geonames.search({
      q: query,
      country,
      featureClass: "P",
      maxRows,
      style: "FULL",
    });

    return result?.geonames || [];
  } catch (error) {
    console.error("[GeoNames] searchCities error:", error.message || error);
    return [];
  }
}

/**
 * Get cities in a country
 */
async function getCitiesByCountry(countryCode = "GB", maxRows = 50) {
  try {
    const result = await geonames.search({
      country: countryCode,
      featureClass: "P",
      maxRows,
      style: "FULL",
      orderby: "population",
    });

    return result?.geonames || [];
  } catch (error) {
    console.error("[GeoNames] getCitiesByCountry error:", error.message || error);
    return [];
  }
}

async function getUKTerritories() {
  const cities = await getCitiesByCountry("GB", 100);

  const unique = new Map();

  for (const city of cities) {
    if (city.population > 100000) {
      unique.set(city.geonameId, city);
    }
  }

  return Array.from(unique.values()).slice(0, 30);
}

module.exports = {
  searchCities,
  getCitiesByCountry,
  getUKTerritories,
};
