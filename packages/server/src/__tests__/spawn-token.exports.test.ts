import { describe, it, expect } from "vitest";
import { constTimeEq } from "../services/spawn-token";

describe("constTimeEq", () => {
  it("returns true for identical strings", () => {
    expect(constTimeEq("abc", "abc")).toBe(true);
  });

  it("returns false for different strings of equal length", () => {
    expect(constTimeEq("abc", "abd")).toBe(false);
  });

  it("returns false when lengths differ regardless of prefix overlap", () => {
    expect(constTimeEq("abc", "abcd")).toBe(false);
    expect(constTimeEq("abcd", "abc")).toBe(false);
  });

  it("returns true for empty strings", () => {
    expect(constTimeEq("", "")).toBe(true);
  });

  it("returns false when comparing against an empty string", () => {
    expect(constTimeEq("a", "")).toBe(false);
    expect(constTimeEq("", "a")).toBe(false);
  });

  it("treats each character independently (a single trailing byte change flips the result)", () => {
    expect(constTimeEq("hello", "hello")).toBe(true);
    expect(constTimeEq("hello", "hellp")).toBe(false);
  });

  it("handles unicode characters by char code", () => {
    expect(constTimeEq("héllo", "héllo")).toBe(true);
    expect(constTimeEq("héllo", "héllo")).toBe(true);
  });
});