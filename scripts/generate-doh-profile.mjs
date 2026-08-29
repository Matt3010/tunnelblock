import fs from "node:fs";
import crypto from "node:crypto";

const template = new URL("../profiles/adblock-doh.mobileconfig.example", import.meta.url);
const output = new URL("../profiles/adblock-doh.mobileconfig", import.meta.url);

let xml = fs.readFileSync(template, "utf8")
  .replace("33333333-3333-3333-3333-333333333333", crypto.randomUUID().toUpperCase())
  .replace("44444444-4444-4444-4444-444444444444", crypto.randomUUID().toUpperCase());

fs.writeFileSync(output, xml);
console.log("generated profiles/adblock-doh.mobileconfig");
