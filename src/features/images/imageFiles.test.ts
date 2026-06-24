import { describe, expect, test } from "vitest";
import { fitDisplayWidth } from "./imageFiles";

// maxWidth ≈ 85% of editor width, maxHeight = DEFAULT_IMAGE_MAX_HEIGHT (180).
describe("fitDisplayWidth", () => {
  test("keeps small images at natural size (returns null)", () => {
    expect(fitDisplayWidth(100, 80, 850, 180)).toBeNull();
  });

  test("returns null when exactly at the limits", () => {
    expect(fitDisplayWidth(850, 180, 850, 180)).toBeNull();
  });

  test("never upscales, even with huge limits", () => {
    expect(fitDisplayWidth(50, 50, 5000, 5000)).toBeNull();
  });

  test("limits a wide image to the max width", () => {
    // height (200) is already under 180? no — but width is the binding scale.
    expect(fitDisplayWidth(2000, 200, 850, 180)).toBe(850);
  });

  test("limits a tall image by height, narrowing the width proportionally", () => {
    // 400x2000 → scale = 180/2000 = 0.09 → width 36, height 180.
    expect(fitDisplayWidth(400, 2000, 850, 180)).toBe(36);
  });

  test("uses the smaller scale when both dimensions exceed", () => {
    // 3000x3000 → height scale 0.06 < width scale ~0.283 → width 180.
    expect(fitDisplayWidth(3000, 3000, 850, 180)).toBe(180);
  });
});
