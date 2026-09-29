FROM alpine:3.22

RUN apk add --no-cache iproute2 nmap

COPY vpn/discovery/lan-discovery.sh /app/lan-discovery.sh

RUN chmod 0755 /app/lan-discovery.sh && sh -n /app/lan-discovery.sh

ENTRYPOINT ["/app/lan-discovery.sh"]
