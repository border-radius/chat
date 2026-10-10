import { describe, expect, it } from "vitest";
import { ApiError, errorMessage } from "../../web/src/api.ts";

describe("errorMessage", () => {
  it("network trouble (status 0) asks to check the connection", () => {
    expect(errorMessage(new ApiError("Failed to fetch", 0))).toBe("Can't reach the server. Check your connection.");
  });

  it("rate limiting asks to wait", () => {
    expect(errorMessage(new ApiError("Too Many Requests.", 429))).toBe("Too many attempts. Wait a few seconds and try again.");
  });

  it("otherwise shows the server's message", () => {
    expect(errorMessage(new ApiError("Failed to authenticate.", 400))).toBe("Failed to authenticate.");
  });

  it("anything that isn't an ApiError gets a generic message", () => {
    expect(errorMessage(new TypeError("x is undefined"))).toBe("Something went wrong. Please try again.");
    expect(errorMessage("nope")).toBe("Something went wrong. Please try again.");
  });
});
