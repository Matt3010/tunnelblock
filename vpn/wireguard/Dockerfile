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
COPY vpn/wireguard/phase2-firewall.sh /app/phase2-firewall.sh

RUN chmod 0755 /app/entrypoint.sh /app/healthcheck.sh /app/show-client.sh /app/phase2-firewall.sh \
    && sh -n /app/entrypoint.sh /app/healthcheck.sh /app/show-client.sh /app/phase2-firewall.sh

VOLUME ["/config"]
EXPOSE 51820/udp

ENTRYPOINT ["/app/entrypoint.sh"]
