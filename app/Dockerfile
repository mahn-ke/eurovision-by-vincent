FROM mcr.microsoft.com/playwright:v1.60.0-noble AS test

WORKDIR /app
COPY ./ /app

RUN npm ci

RUN mkdir -p /app/test-results /app/playwright-report

RUN npm run test:e2e

RUN find /app/test-results -type f -name '*.webm' -delete

FROM scratch AS test-results

COPY --from=test /app/test-results /test-results
COPY --from=test /app/playwright-report /playwright-report

FROM node:26-alpine AS runtime

WORKDIR /app
COPY ./ /app

RUN npm ci --omit=dev

CMD ["npm", "run", "start"]
