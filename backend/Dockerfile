FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV KANJI_HOST=0.0.0.0
ENV KANJI_PORT=8787
ENV KANJI_DATA_DIR=/app/data

COPY package.json ./
COPY src ./src

RUN addgroup -S kanji && adduser -S kanji -G kanji \
  && mkdir -p /app/data /app/uploads/avatars \
  && chown -R kanji:kanji /app

USER kanji
EXPOSE 8787

CMD ["node", "src/server.js"]
