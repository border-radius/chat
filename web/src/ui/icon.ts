// The collections icon (§31), drawn by CSS (.ci in styles/app/collections.css): a picture with another behind it.

import { h } from "../dom.ts";

export const collectionIcon = (): HTMLElement => h("span", { class: "ci", "aria-hidden": "true" });
