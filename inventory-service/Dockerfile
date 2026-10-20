# ---- build stage: install production dependencies only ----
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src

# ---- runtime stage: small image, non-root user ----
FROM node:22-alpine
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY --from=builder /app /app
USER app
ENV NODE_ENV=production
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/health || exit 1
CMD ["node", "src/server.js"]
