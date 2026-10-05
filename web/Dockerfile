FROM node:24-alpine

WORKDIR /app

COPY web/package*.json ./
RUN npm install

COPY web/src ./src
COPY web/test ./test
COPY web/public ./public

USER node

CMD ["npm", "start"]
