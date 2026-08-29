import { describe, expect, it } from "vitest";
import { RuleEngine } from "../src/rules.js";

describe("RuleEngine", () => {
  it("gives manual allow the highest precedence", () => {
    const rules = new RuleEngine(
      new Set(["ads.example.com"]),
      new Set(["example.com"]),
      new Set(["example.com"]),
    );

    expect(rules.decideDetailed("ads.example.com")).toEqual({
      decision: "allow",
      source: "manual-allow",
    });
  });

  it("gives manual block precedence over external lists", () => {
    const rules = new RuleEngine(
      new Set(["tracker.example.com"]),
      new Set(),
      new Set(["example.com"]),
    );

    expect(rules.decideDetailed("tracker.example.com")).toEqual({
      decision: "block",
      source: "manual-block",
    });
  });

  it("blocks subdomains from an external list", () => {
    const rules = new RuleEngine(
      new Set(),
      new Set(),
      new Set(["example.com"]),
    );

    expect(rules.decideDetailed("a.b.example.com")).toEqual({
      decision: "block",
      source: "external-block",
    });
  });

  it("returns the exact matching parent rule", () => {
    const rules = new RuleEngine(
      new Set(["example.com"]),
      new Set(),
      new Set(),
    );

    expect(rules.explain("ads.deep.example.com")).toEqual({
      decision: "block",
      source: "manual-block",
      matchedRule: "example.com",
    });
  });

  it("allows unmatched domains by default", () => {
    const rules = new RuleEngine(new Set(), new Set(), new Set());

    expect(rules.decideDetailed("example.org")).toEqual({
      decision: "allow",
      source: "default",
    });

    expect(rules.explain("example.org")).toEqual({
      decision: "allow",
      source: "default",
      matchedRule: null,
    });
  });
});
