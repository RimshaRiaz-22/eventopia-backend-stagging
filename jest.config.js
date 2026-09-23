/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  testMatch: ["**/__tests__/**/*.test.js", "**/*.test.js"],
  collectCoverageFrom: ["src/**/*.js", "!src/**/*.test.js"],
  coverageDirectory: "coverage",
  verbose: true,
  testTimeout: 10000,
};
