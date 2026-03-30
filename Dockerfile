FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src/ ./src/
ENV PORT=9090
EXPOSE 9090
CMD ["node", "src/index.js"]
