import fs from "node:fs";

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function parse(text: string): Set<string> {
  return new Set(
    text
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith("#"))
      .map(normalize),
  );
}

function read(file: string | undefined): Set<string> {
  if (!file || !fs.existsSync(file)) return new Set();
  return parse(fs.readFileSync(file, "utf8"));
}

function matches(host: string, rules: Set<string>): boolean {
  let current = host;

  while (true) {
    if (rules.has(current)) return true;
    const dot = current.indexOf(".");
    if (dot === -1) return false;
    current = current.slice(dot + 1);
  }
}

export type RuleDecisionSource =
  | "manual-allow"
  | "manual-block"
  | "external-block"
  | "default";

export class RuleEngine {
  constructor(
    private readonly manualBlocked: Set<string>,
    private readonly manualAllowed: Set<string>,
    private readonly externalBlocked: Set<string> = new Set(),
  ) {}

  static fromFiles(
    blockPath: string,
    allowPath: string,
    externalBlockPath?: string,
  ): RuleEngine {
    return new RuleEngine(
      read(blockPath),
      read(allowPath),
      read(externalBlockPath),
    );
  }

  decideDetailed(hostname: string): {
    decision: "allow" | "block";
    source: RuleDecisionSource;
  } {
    const host = normalize(hostname);

    if (matches(host, this.manualAllowed)) {
      return { decision: "allow", source: "manual-allow" };
    }

    if (matches(host, this.manualBlocked)) {
      return { decision: "block", source: "manual-block" };
    }

    if (matches(host, this.externalBlocked)) {
      return { decision: "block", source: "external-block" };
    }

    return { decision: "allow", source: "default" };
  }

  decide(hostname: string): "allow" | "block" {
    return this.decideDetailed(hostname).decision;
  }
}
