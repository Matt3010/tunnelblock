FROM node:24-alpine

RUN apk add --no-cache git docker-cli docker-cli-compose curl

ARG UPDATER_BUILD_SHA=dev
ENV UPDATER_BUILD_SHA=$UPDATER_BUILD_SHA

WORKDIR /app

COPY updater/package*.json ./
RUN npm install

COPY updater/src ./src
RUN npm run typecheck

COPY updater/replace-self.sh /replace-self.sh
COPY updater/bootstrap-update.sh /bootstrap-update.sh
COPY updater/update-state.mjs /update-state.mjs
RUN chmod +x /replace-self.sh /bootstrap-update.sh /update-state.mjs

CMD ["npm", "start"]
