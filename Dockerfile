FROM node:24-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY prisma ./prisma/

# Install dependencies
RUN npm ci

# Copy application source
COPY . .

# Generate Prisma client and build Nest app
RUN npx prisma generate
RUN npm run build

FROM node:24-alpine

WORKDIR /app

# Copy node_modules and built assets
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./

# Add a start script to handle migrations and seeding
RUN cat << 'EOF' > /start.sh
#!/bin/sh
echo "Starting NestJS..."
node dist/src/main
EOF
RUN chmod +x /start.sh

EXPOSE 3000

CMD ["/start.sh"]
