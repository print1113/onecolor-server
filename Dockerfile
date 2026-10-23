FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY src ./src
COPY scripts ./scripts
ENV NODE_ENV=production PORT=8787 DB_PATH=/data/onecolor.db
VOLUME ["/data"]
EXPOSE 8787
CMD ["node", "--no-warnings", "src/index.js"]
