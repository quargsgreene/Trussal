FROM node:20-alpine

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm ci

COPY server.js room-indices.js ./

EXPOSE 8081

CMD ["npm", "start"]
