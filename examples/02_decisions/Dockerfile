FROM node:24-alpine

# The Gateway starts the agent's container itself, through the Docker socket compose binds in.
RUN apk add --no-cache docker-cli

WORKDIR /app

COPY package.json ./
RUN npm install --no-audit --no-fund

# The signing key is not copied. It arrives as a read-only bind, so the image ships no private key
# and swapping in a real one changes nothing here.
COPY main.ts schema.ts drizzle.config.ts message-received.hbs ./

# The `migrate` service runs the same image with `drizzle-kit push --force` instead.
CMD ["node", "main.ts"]
