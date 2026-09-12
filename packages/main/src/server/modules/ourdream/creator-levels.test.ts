import { describe, expect, it } from "vitest";
import { resolveCreatorLevel } from "./creator-levels";
describe("creator level policy", () => {
 it("uses published canonical facts and requires all thresholds", () => {
  expect(resolveCreatorLevel({publishedCharacters:0,publishedComics:0,followers:0})).toBe("starter");
  expect(resolveCreatorLevel({publishedCharacters:1,publishedComics:0,followers:0})).toBe("rising");
  expect(resolveCreatorLevel({publishedCharacters:10,publishedComics:3,followers:250})).toBe("pro");
  expect(resolveCreatorLevel({publishedCharacters:25,publishedComics:10,followers:1000})).toBe("studio");
  expect(resolveCreatorLevel({publishedCharacters:25,publishedComics:10,followers:999})).toBe("pro");
 });
});
