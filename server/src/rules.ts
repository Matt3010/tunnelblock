import fs from "node:fs";

export type FilterDecision = "allow" | "block";

function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function parseRules(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith("#"))
    .map(normalizeHost);
}

function hostMatches(host: string, rule: string): boolean {
  return host === rule || host.endsWith("." + rule);
}

export class RuleEngine {
  constructor(
    private readonly blocked: string[],
    private readonly allowed: string[],
  ) {}

  static fromFiles(blockPath: string, allowPath: string): RuleEngine {
    return new RuleEngine(
      parseRules(fs.readFileSync(blockPath, "utf8")),
      parseRules(fs.readFileSync(allowPath, "utf8")),
    );
  }

  decide(hostname: string): FilterDecision {
    const host = normalizeHost(hostname);
    if (this.allowed.some(rule => hostMatches(host, rule))) return "allow";
    if (this.blocked.some(rule => hostMatches(host, rule))) return "block";
    return "allow";
  }
}
