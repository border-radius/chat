// The app shares the web client's API layer, state and room logic (../web/src): Metro must watch and resolve it.
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
config.watchFolders = [path.resolve(__dirname, "../web/src")];
module.exports = config;
