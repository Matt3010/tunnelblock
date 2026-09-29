FROM alpine:3.22

RUN apk add --no-cache \
    ca-certificates \
    busybox-extras \
    curl \
    dnsmasq \
    iproute2 \
    iptables \
    kmod \
    musl-utils \
    libqrencode-tools \
    wireguard-tools

WORKDIR /app

COPY vpn/wireguard/entrypoint.sh /app/entrypoint.sh
COPY vpn/wireguard/healthcheck.sh /app/healthcheck.sh
COPY vpn/wireguard/show-client.sh /app/show-client.sh
COPY vpn/wireguard/peer-manager.sh /app/peer-manager.sh
COPY vpn/wireguard/https-firewall.sh /app/https-firewall.sh
COPY vpn/wireguard/lan-acl.sh /app/lan-acl.sh

RUN chmod 0755 /app/entrypoint.sh /app/healthcheck.sh /app/show-client.sh /app/peer-manager.sh /app/https-firewall.sh /app/lan-acl.sh \
    && sh -n /app/entrypoint.sh /app/healthcheck.sh /app/show-client.sh /app/peer-manager.sh /app/https-firewall.sh /app/lan-acl.sh

VOLUME ["/config"]
EXPOSE 51820/udp

ENTRYPOINT ["/app/entrypoint.sh"]
