// Design tokens (the web's styles/app/tokens.css, §7.8): the same purple accent, surfaces and avatar palette, light and
// dark, following the system setting.

import { useColorScheme } from "react-native";

export interface Theme {
  dark: boolean;
  bg: string;
  surface: string;
  raised: string;
  fg: string;
  muted: string;
  border: string;
  hover: string;
  accent: string;
  accent2: string;
  /** Text on the accent color. */
  onAccent: string;
  tint: string;
  danger: string;
  highlight: string;
  radius: number;
}

const light: Theme = {
  dark: false,
  bg: "#fbfaff",
  surface: "#f1eefc",
  raised: "#ffffff",
  fg: "#1d1530",
  muted: "#5e5874",
  border: "#e3ddf5",
  hover: "#e9e4fb",
  accent: "#5b3df5",
  accent2: "#c42a7c",
  onAccent: "#ffffff",
  tint: "rgba(91, 61, 245, 0.12)",
  danger: "#c41d36",
  highlight: "#fff1b8",
  radius: 12,
};

const dark: Theme = {
  dark: true,
  bg: "#1a1726",
  surface: "#13111d",
  raised: "#242036",
  fg: "#efecfa",
  muted: "#a8a2c0",
  border: "#2f2a45",
  hover: "#2a2540",
  accent: "#a99bff",
  accent2: "#c42a7c",
  onAccent: "#13111d",
  tint: "rgba(169, 155, 255, 0.16)",
  danger: "#ff7a8f",
  highlight: "#3d3314",
  radius: 12,
};

/** White text on every one: ≥ 4.5:1 (styles/app/avatars.css). */
export const AVATAR_COLORS = ["#c4213b", "#b04a00", "#7a6000", "#22803a", "#00796b", "#1d63d8", "#7b3fe4", "#c01a6e"];

export function useTheme(): Theme {
  return useColorScheme() === "dark" ? dark : light;
}
