import fs from "node:fs";

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function parse(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith("#"))
    .map(normalize);
}

function matches(host: string, rule: string): boolean {
  return host === rule || host.endsWith("." + rule);
}

export class RuleEngine {
  constructor(
    private readonly blocked: string[],
    private readonly allowed: string[],
  ) {}

  static fromFiles(blockPath: string, allowPath: string): RuleEngine {
    return new RuleEngine(
      parse(fs.readFileSync(blockPath, "utf8")),
      parse(fs.readFileSync(allowPath, "utf8")),
    );
  }

  decide(hostname: string): "allow" | "block" {
    const host = normalize(hostname);
    if (this.allowed.some(rule => matches(host, rule))) return "allow";
    if (this.blocked.some(rule => matches(host, rule))) return "block";
    return "allow";
  }
}
