FROM node:24-alpine

WORKDIR /app

COPY dns/package*.json ./
RUN npm install

COPY dns/src ./src
COPY dns/test ./test
COPY rules /defaults
COPY dns/entrypoint.sh /entrypoint.sh
COPY dns/migrate-rules.sh /migrate-rules.sh

RUN chmod +x /entrypoint.sh /migrate-rules.sh
RUN mkdir -p /tmp/rules-test \
  && printf 'doubleclick.net\r\nkeep.example\n googleadservices.com \n' > /tmp/rules-test/block.txt \
  && RULES_DIR=/tmp/rules-test /migrate-rules.sh \
  && grep -qx 'keep.example' /tmp/rules-test/block.txt \
  && ! grep -Eq 'doubleclick\.net|googleadservices\.com|googlesyndication\.com|app-measurement\.com' /tmp/rules-test/block.txt \
  && rm -rf /tmp/rules-test

ENV HOST=0.0.0.0
ENV PORT=8053
ENV UPSTREAM_DNS_HOST=1.1.1.1
ENV UPSTREAM_DNS_PORT=53

EXPOSE 8053 53/tcp 53/udp

ENTRYPOINT ["/entrypoint.sh"]
