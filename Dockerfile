FROM mcr.microsoft.com/playwright:v1.57.0-jammy AS base
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3005
CMD ["npm", "start"]
