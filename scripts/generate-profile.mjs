import fs from "node:fs";
import crypto from "node:crypto";

const templatePath = new URL("../profiles/adblock.mobileconfig.example", import.meta.url);
const outputPath = new URL("../profiles/adblock.mobileconfig", import.meta.url);

const username = process.env.VPN_USERNAME ?? "adblock";

let xml = fs.readFileSync(templatePath, "utf8")
  .replace("11111111-1111-1111-1111-111111111111", crypto.randomUUID().toUpperCase())
  .replace("22222222-2222-2222-2222-222222222222", crypto.randomUUID().toUpperCase())
  .replace("<string>adblock</string>", `<string>${username}</string>`);

fs.writeFileSync(outputPath, xml);
console.log("generated profiles/adblock.mobileconfig");
