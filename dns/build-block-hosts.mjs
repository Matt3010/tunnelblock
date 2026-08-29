import fs from "node:fs";

const source = new URL("../rules/block.txt", import.meta.url);
const output = new URL("./block.hosts", import.meta.url);

const domains = fs.readFileSync(source, "utf8")
  .split(/\r?\n/)
  .map(line => line.trim())
  .filter(line => line && !line.startsWith("#"));

const hosts = domains
  .map(domain => `0.0.0.0 ${domain}\n:: ${domain}`)
  .join("\n");

fs.writeFileSync(output, hosts + "\n");
console.log(`wrote ${domains.length} blocked domains`);
