FROM node:20-alpine

# Cài thêm 'usbutils' để đọc thông tin cổng USB
RUN apk update && apk add --no-cache docker-cli procps usbutils

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 4000
CMD ["npm", "start"]
