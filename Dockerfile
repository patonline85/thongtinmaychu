# Sử dụng Node.js 20 bản nhẹ
FROM node:20-alpine

# CÀI ĐẶT THÊM CÔNG CỤ QUAN TRỌNG:
# - docker-cli: Để app có thể chạy lệnh 'docker stats'
# - procps: Cung cấp lệnh 'top' và 'free' chuẩn để đọc CPU/RAM máy chủ
RUN apk update && apk add --no-cache docker-cli procps

WORKDIR /app

# Copy package và cài đặt
COPY package*.json ./
RUN npm install

# Copy toàn bộ mã nguồn
COPY . .

EXPOSE 4000

CMD ["npm", "start"]