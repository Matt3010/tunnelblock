FROM node:24-alpine

WORKDIR /app

COPY dns/package*.json ./
RUN npm install

COPY dns/src ./src
COPY dns/test ./test
COPY rules /defaults
COPY dns/entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh

ENV HOST=0.0.0.0
ENV PORT=8053
ENV UPSTREAM_DNS_HOST=1.1.1.1
ENV UPSTREAM_DNS_PORT=53

EXPOSE 8053

ENTRYPOINT ["/entrypoint.sh"]
