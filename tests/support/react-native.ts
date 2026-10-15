// What the app's core modules (mobile/src/core) read from React Native, for unit tests: the unit project aliases
// "react-native" here (vitest.config.ts). Tests set Platform.OS to take the native or the web path.
export const Platform = { OS: "android" as string };
