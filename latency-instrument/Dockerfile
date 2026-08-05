FROM node:20-alpine

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm ci

COPY server.js room-indices.js o2lite-format.js o2-relay.js scss-compile.js ./

EXPOSE 8081 8082

CMD ["npm", "start"]
