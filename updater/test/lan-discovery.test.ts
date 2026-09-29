import assert from "node:assert/strict";
import test from "node:test";
import { isPrivateIpv4, parseDiscoveryOutput, validLanRule } from "../src/lan-discovery.js";

const sample = `# tunnelblock-discovery interface=eth0 self=192.168.1.5 target=192.168.1.5/24
<?xml version="1.0" encoding="UTF-8"?>
<nmaprun scanner="nmap" args="nmap -sS" version="7.95">
<hosthint><status state="up" reason="arp-response"/><address addr="192.168.1.20" addrtype="ipv4"/></hosthint>
<host starttime="1" endtime="2"><status state="up" reason="arp-response" reason_ttl="0"/>
<address addr="192.168.1.20" addrtype="ipv4"/>
<address addr="00:11:32:AA:BB:CC" addrtype="mac" vendor="Synology &amp; Co"/>
<hostnames>
<hostname name="nas.lan" type="PTR"/>
</hostnames>
<ports><extraports state="closed" count="80"><extrareasons reason="reset" count="80"/></extraports>
<port protocol="tcp" portid="5000"><state state="open" reason="syn-ack" reason_ttl="64"/><service name="upnp" method="table" conf="3"/></port>
<port protocol="tcp" portid="22"><state state="open" reason="syn-ack" reason_ttl="64"/><service name="ssh" method="table" conf="3"/></port>
<port protocol="tcp" portid="23"><state state="filtered" reason="no-response" reason_ttl="0"/><service name="telnet" method="table" conf="3"/></port>
</ports>
</host>
<host starttime="1" endtime="2"><status state="up" reason="localhost-response" reason_ttl="0"/>
<address addr="192.168.1.5" addrtype="ipv4"/>
<hostnames></hostnames>
<ports><port protocol="tcp" portid="22"><state state="open" reason="syn-ack" reason_ttl="64"/><service name="ssh" method="table" conf="3"/></port></ports>
</host>
<host starttime="1" endtime="2"><status state="up" reason="arp-response" reason_ttl="0"/>
<address addr="192.168.1.3" addrtype="ipv4"/>
<address addr="24:0A:C4:00:00:01" addrtype="mac" vendor="Espressif"/>
<hostnames></hostnames>
<ports><extraports state="closed" count="82"></extraports></ports>
</host>
<runstats><finished time="3"/><hosts up="3" down="253" total="256"/></runstats>
</nmaprun>
`;

test("parses discovered LAN hosts, open ports and metadata", () => {
  const inventory = parseDiscoveryOutput(sample, "2026-09-29T10:00:00.000Z");
  assert.equal(inventory.interface, "eth0");
  assert.equal(inventory.target, "192.168.1.5/24");
  assert.deepEqual(inventory.hosts.map(host => host.ip), ["192.168.1.3", "192.168.1.5", "192.168.1.20"]);

  const nas = inventory.hosts[2];
  assert.equal(nas.hostname, "nas.lan");
  assert.equal(nas.vendor, "Synology & Co");
  assert.deepEqual(nas.ports, [
    { protocol: "tcp", port: 22, service: "ssh" },
    { protocol: "tcp", port: 5000, service: "upnp" },
  ]);

  assert.equal(inventory.hosts[1].self, true);
  assert.equal(inventory.hosts[0].vendor, "Espressif");
  assert.deepEqual(inventory.hosts[0].ports, []);
});

test("accepts only private IPv4 LAN rules", () => {
  assert.equal(isPrivateIpv4("192.168.1.10"), true);
  assert.equal(isPrivateIpv4("172.31.0.1"), true);
  assert.equal(isPrivateIpv4("172.32.0.1"), false);
  assert.equal(isPrivateIpv4("8.8.8.8"), false);

  assert.equal(validLanRule("192.168.1.10/any"), true);
  assert.equal(validLanRule("10.0.0.2/tcp/8123"), true);
  assert.equal(validLanRule("10.0.0.2/udp/1900"), true);
  assert.equal(validLanRule("10.0.0.2/tcp/0"), false);
  assert.equal(validLanRule("10.0.0.2/tcp/65536"), false);
  assert.equal(validLanRule("10.0.0.256/any"), false);
  assert.equal(validLanRule("1.1.1.1/any"), false);
  assert.equal(validLanRule("10.0.0.2/icmp/1"), false);
  assert.equal(validLanRule("10.0.0.2/any; rm -rf /"), false);
});
