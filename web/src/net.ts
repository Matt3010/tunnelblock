import net from "node:net";

const privateV4 = new net.BlockList();
privateV4.addSubnet("10.0.0.0", 8);
privateV4.addSubnet("172.16.0.0", 12);
privateV4.addSubnet("192.168.0.0", 16);
privateV4.addSubnet("169.254.0.0", 16);
privateV4.addSubnet("127.0.0.0", 8);

const privateV6 = new net.BlockList();
privateV6.addAddress("::1", "ipv6");
privateV6.addSubnet("fc00::", 7, "ipv6");
privateV6.addSubnet("fe80::", 10, "ipv6");

/** LAN, VPN, Docker and loopback sources. The panel never answers anyone else. */
export function isPrivateAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  const value = mapped ? mapped[1] : ip;
  const family = net.isIP(value);
  if (family === 4) return privateV4.check(value, "ipv4");
  if (family === 6) return privateV6.check(value, "ipv6");
  return false;
}
