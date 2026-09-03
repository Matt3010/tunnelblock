FROM node:24-alpine

WORKDIR /app

COPY telegram/package*.json ./
RUN npm install

COPY telegram/src ./src
COPY telegram/test ./test

CMD ["npm", "start"]
