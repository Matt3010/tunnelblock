FROM node:24-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
COPY test ./test
COPY ../rules /rules

ENV HOST=0.0.0.0
ENV PORT=8053
ENV UPSTREAM_DNS_HOST=1.1.1.1
ENV UPSTREAM_DNS_PORT=53

EXPOSE 8053

CMD ["npm", "start"]
