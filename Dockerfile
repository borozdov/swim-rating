FROM node:22-alpine
WORKDIR /app
COPY server.js ./
COPY public ./public
EXPOSE 4173
CMD ["node", "server.js"]
