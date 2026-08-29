FROM node:24-alpine

RUN apk add --no-cache git docker-cli docker-cli-compose curl

WORKDIR /app

COPY updater/package*.json ./
RUN npm install

COPY updater/src ./src

CMD ["npm", "start"]
