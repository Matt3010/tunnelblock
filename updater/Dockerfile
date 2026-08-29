FROM node:24-alpine

RUN apk add --no-cache git docker-cli docker-cli-compose curl

WORKDIR /app

COPY updater/package*.json ./
RUN npm install

COPY updater/src ./src
COPY updater/replace-self.sh /replace-self.sh
RUN chmod +x /replace-self.sh

CMD ["npm", "start"]
