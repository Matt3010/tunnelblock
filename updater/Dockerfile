FROM node:24-alpine

RUN apk add --no-cache git docker-cli docker-cli-compose

WORKDIR /app

COPY updater/package*.json ./
RUN npm install

COPY updater/src ./src
COPY updater/test ./test
RUN npm run typecheck

CMD ["npm", "start"]
