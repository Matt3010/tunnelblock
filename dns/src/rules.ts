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

function findMatch(host: string, rules: Set<string>): string | null {
  let current = host;

  while (true) {
    if (rules.has(current)) return current;
    const dot = current.indexOf(".");
    if (dot === -1) return null;
    current = current.slice(dot + 1);
  }
}

export type RuleDecisionSource =
  | "manual-allow"
  | "manual-block"
  | "external-block"
  | "default";

export type RuleExplanation = {
  decision: "allow" | "block";
  source: RuleDecisionSource;
  matchedRule: string | null;
};

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

  explain(hostname: string): RuleExplanation {
    const host = normalize(hostname);

    const allowMatch = findMatch(host, this.manualAllowed);
    if (allowMatch) {
      return { decision: "allow", source: "manual-allow", matchedRule: allowMatch };
    }

    const manualBlockMatch = findMatch(host, this.manualBlocked);
    if (manualBlockMatch) {
      return { decision: "block", source: "manual-block", matchedRule: manualBlockMatch };
    }

    const externalBlockMatch = findMatch(host, this.externalBlocked);
    if (externalBlockMatch) {
      return { decision: "block", source: "external-block", matchedRule: externalBlockMatch };
    }

    return { decision: "allow", source: "default", matchedRule: null };
  }

  decideDetailed(hostname: string): {
    decision: "allow" | "block";
    source: RuleDecisionSource;
  } {
    const { decision, source } = this.explain(hostname);
    return { decision, source };
  }

  decide(hostname: string): "allow" | "block" {
    return this.explain(hostname).decision;
  }
}
