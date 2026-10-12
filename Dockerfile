FROM node:20-alpine
WORKDIR /opt/commutepool
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev
COPY client ./client
COPY server ./server
COPY schema.sql ./schema.sql
WORKDIR /opt/commutepool/server
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
