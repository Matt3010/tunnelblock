FROM node:24-alpine

RUN apk add --no-cache git docker-cli docker-cli-compose curl

ARG UPDATER_BUILD_SHA=dev
ENV UPDATER_BUILD_SHA=$UPDATER_BUILD_SHA

WORKDIR /app

COPY updater/package*.json ./
RUN npm install

COPY updater/src ./src
RUN npm run typecheck

COPY updater/bootstrap-update.sh /bootstrap-update.sh
COPY updater/update-state.mjs /update-state.mjs
COPY ops/deploy.sh /deploy-check.sh
RUN sh -n /bootstrap-update.sh /deploy-check.sh \
    && node --check /update-state.mjs \
    && rm /deploy-check.sh \
    && chmod +x /bootstrap-update.sh /update-state.mjs

CMD ["npm", "start"]
