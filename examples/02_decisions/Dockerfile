FROM node:24-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --no-audit --no-fund

COPY main.ts drizzle.config.ts schema.ts ./

CMD ["node", "main.ts"]
