import { describe, expect, it } from "vitest";
import { RuleEngine } from "../src/rules.js";

describe("RuleEngine", () => {
  it("blocks a domain and its subdomains", () => {
    const engine = new RuleEngine(["doubleclick.net"], []);
    expect(engine.decide("doubleclick.net")).toBe("block");
    expect(engine.decide("ads.doubleclick.net")).toBe("block");
  });

  it("does not false-match suffixes", () => {
    const engine = new RuleEngine(["doubleclick.net"], []);
    expect(engine.decide("notdoubleclick.net")).toBe("allow");
  });

  it("allow rules override block rules", () => {
    const engine = new RuleEngine(["example.com"], ["safe.example.com"]);
    expect(engine.decide("safe.example.com")).toBe("allow");
    expect(engine.decide("ads.example.com")).toBe("block");
  });
});
