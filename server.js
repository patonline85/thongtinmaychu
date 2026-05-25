const express = require('express');
const { exec } = require('child_process');
const session = require('express-session');
const dotenv = require('dotenv');
const path = require('path');
const os = require('os');

dotenv.config();
const app = express();
const PORT = process.env.PORT || 4000;

app.use(express.json());
app.use(session({
    secret: 'super-secret-monitor-key',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // Đăng nhập lưu trong 24h
}));

// Middleware kiểm tra đăng nhập
const requireAuth = (req, res, next) => {
    if (req.session.loggedIn) next();
    else res.status(401).json({ error: "Vui lòng đăng nhập" });
};

// API Đăng nhập
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
        req.session.loggedIn = true;
        res.json({ success: true });
    } else {
        res.status(403).json({ success: false, error: "Sai tài khoản hoặc mật khẩu!" });
    }
});

// API Đăng xuất
app.get('/api/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// API Lấy thông số hệ thống (CPU, RAM, Ổ cứng, USB)
app.get('/api/system', requireAuth, (req, res) => {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    
    // 1. Chạy lệnh lấy CPU
    exec("top -bn1 | grep 'Cpu(s)' | sed 's/.*, *\\([0-9.]*\\)%* id.*/\\1/' | awk '{print 100 - $1}'", (errCpu, stdoutCpu) => {
        const cpuUsage = errCpu ? 0 : parseFloat(stdoutCpu.trim());
        
        // 2. Chạy lệnh lấy Ổ cứng (đọc từ thư mục /hostfs)
        exec("df -h /hostfs | awk 'NR==2 {print $2 \"|\" $3 \"|\" $4 \"|\" $5}'", (errDisk, stdoutDisk) => {
            const diskParts = (stdoutDisk || "").trim().split('|');
            const diskInfo = diskParts.length === 4 ? {
                total: diskParts[0], used: diskParts[1], free: diskParts[2], percent: diskParts[3]
            } : { total: "0G", used: "0G", free: "0G", percent: "0%" };

            // 3. Chạy lệnh quét cổng USB
            exec("lsusb", (errUsb, stdoutUsb) => {
                const usbList = stdoutUsb ? stdoutUsb.trim().split('\n').filter(l => l) : [];

                res.json({
                    cpu: cpuUsage.toFixed(1),
                    memory: {
                        used: (usedMem / 1024 / 1024 / 1024).toFixed(2),
                        total: (totalMem / 1024 / 1024 / 1024).toFixed(2),
                        percent: ((usedMem / totalMem) * 100).toFixed(1)
                    },
                    disk: diskInfo,
                    usb: usbList.length > 0 ? usbList : ["Không có thiết bị USB nào kết nối"]
                });
            });
        });
    });
});

// API Lấy thông số Docker (Thay thế ctop)
app.get('/api/docker', requireAuth, (req, res) => {
    // ĐÃ XÓA {{.Status}} ĐỂ FIX LỖI TEMPLATE PARSING
    exec('docker stats --no-stream --format "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}" ', (err, stdout, stderr) => {
        if (err || stderr) {
            console.error("⛔ Lỗi lấy dữ liệu Docker:", err?.message || stderr);
            return res.status(500).json({ error: "Không thể lấy dữ liệu Docker", details: err?.message || stderr });
        }
        
        try {
            const containers = stdout.trim().split('\n').filter(line => line).map(line => {
                const [name, cpu, mem, memPerc] = line.split('|');
                return { name, cpu, mem, memPerc };
            });
            res.json({ containers });
        } catch (parseError) {
            console.error("⛔ Lỗi phân tích dữ liệu:", parseError);
            res.json({ containers: [] });
        }
    });
});

// Phục vụ giao diện Web
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
    console.log(`📡 Server Monitor đang chạy tại cổng ${PORT}`);
});
