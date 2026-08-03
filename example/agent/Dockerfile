FROM node:24-alpine

RUN apk add --no-cache curl

RUN npm install -g @earendil-works/pi-coding-agent@0.83.0

WORKDIR /workspace
ENV PI_CODING_AGENT_DIR=/home/agent/.pi/agent

ENTRYPOINT ["pi"]
