import NetworkExtension
import os

final class PacketTunnelProvider: NEPacketTunnelProvider {
    private let logger = Logger(
        subsystem: "dev.adblock.generalpurpose",
        category: "PacketTunnel"
    )

    override func startTunnel(
        options: [String : NSObject]?,
        completionHandler: @escaping (Error?) -> Void
    ) {
        let settings = NEPacketTunnelNetworkSettings(
            tunnelRemoteAddress: "127.0.0.1"
        )

        let ipv4 = NEIPv4Settings(
            addresses: ["10.7.0.2"],
            subnetMasks: ["255.255.255.0"]
        )
        ipv4.includedRoutes = [NEIPv4Route.default()]
        settings.ipv4Settings = ipv4

        let dns = NEDNSSettings(servers: ["10.7.0.1"])
        dns.matchDomains = [""]
        settings.dnsSettings = dns

        setTunnelNetworkSettings(settings) { [weak self] error in
            if let error {
                self?.logger.error("Tunnel configuration failed: \(error.localizedDescription, privacy: .public)")
                completionHandler(error)
                return
            }

            self?.logger.info("Packet tunnel configured")
            self?.startPacketLoop()
            completionHandler(nil)
        }
    }

    override func stopTunnel(
        with reason: NEProviderStopReason,
        completionHandler: @escaping () -> Void
    ) {
        logger.info("Packet tunnel stopped: \(reason.rawValue)")
        completionHandler()
    }

    private func startPacketLoop() {
        packetFlow.readPackets { [weak self] packets, _ in
            guard let self else { return }
            self.logger.debug("Captured \(packets.count) packets")
            self.startPacketLoop()
        }
    }
}
