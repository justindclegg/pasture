FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV PORT=4321 PASTURE_DB=/data/pasture.db
VOLUME /data
EXPOSE 4321
CMD ["node", "src/server.js"]
