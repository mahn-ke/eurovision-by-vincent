FROM mcr.microsoft.com/playwright:v1.60.0-noble AS test

WORKDIR /app
COPY ./ /app

RUN npm ci

RUN npm run test:e2e

FROM node:26-alpine AS runtime

WORKDIR /app
COPY ./ /app

RUN npm ci --omit=dev

CMD ["npm", "run", "start"]
