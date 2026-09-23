const geonames = require("../services/geonames.service");

/**
 * Get or search territories from GeoNames
 * GET /territories?q=London
 * - If `q` is provided, searches cities
 * - If no `q`, fetches all UK territories
 */
async function getTerritories(req, res) {
  try {
    const { q, country = "GB" } = req.query;

    let cities;

    if (q && q.trim().length > 0) {
      // Search cities if query is provided
      cities = await geonames.searchCities(q.trim(), country, 10);
    } else {
      // Otherwise, get all UK territories
      cities = await geonames.getUKTerritories();
    }

    // Format response
    const territories = cities.map((city) => ({
      name: city.name,
      country: city.countryName || "UK",
      region: city.adminName1 || null,
      population: city.population || null,
      geonameId: city.geonameId || null,
    }));

    return res.json({
      error: false,
      message: q ? "Territories found successfully." : "Territories retrieved successfully from GeoNames.",
      data: {
        territories,
        count: territories.length,
      },
    });
  } catch (err) {
    console.error("Territories error:", err);
    return res.status(500).json({
      error: true,
      message: "Unable to retrieve territories from GeoNames at the moment. Please try again later.",
      data: null,
    });
  }
}

module.exports = {
  getTerritories,
};
