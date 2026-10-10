// Upload fixtures shared by the unit, integration and e2e suites.

/** A valid 1×1 PNG. */
export const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export const PNG = Uint8Array.from(atob(PNG_BASE64), (c) => c.charCodeAt(0));

/** A PNG `File` under any name. */
export const pngFile = (name = "image.png") => new File([PNG], name, { type: "image/png" });
