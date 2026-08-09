FROM node:24-alpine

RUN apk add --no-cache docker-cli

WORKDIR /app

COPY package.json ./
RUN npm install --no-audit --no-fund

COPY main.ts schema.ts drizzle.config.ts ./

CMD ["node", "main.ts"]
