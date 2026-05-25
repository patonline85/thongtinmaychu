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

// API Lấy thông số hệ thống (CPU, RAM máy chủ)
app.get('/api/system', requireAuth, (req, res) => {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    
    // Chạy lệnh top 1 lần để lấy CPU
    exec("top -bn1 | grep 'Cpu(s)' | sed 's/.*, *\\([0-9.]*\\)%* id.*/\\1/' | awk '{print 100 - $1}'", (err, stdout) => {
        const cpuUsage = err ? 0 : parseFloat(stdout.trim());
        
        res.json({
            cpu: cpuUsage.toFixed(1),
            memory: {
                used: (usedMem / 1024 / 1024 / 1024).toFixed(2),
                total: (totalMem / 1024 / 1024 / 1024).toFixed(2),
                percent: ((usedMem / totalMem) * 100).toFixed(1)
            }
        });
    });
});

// API Lấy thông số Docker (Thay thế ctop)
// API Lấy thông số Docker (Thay thế ctop)
app.get('/api/docker', requireAuth, (req, res) => {
    exec('docker stats --no-stream --format "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.Status}}" ', (err, stdout, stderr) => {
        if (err || stderr) {
            console.error("⛔ Lỗi lấy dữ liệu Docker:", err?.message || stderr);
            return res.status(500).json({ error: "Không thể lấy dữ liệu Docker", details: err?.message || stderr });
        }
        
        try {
            const containers = stdout.trim().split('\n').filter(line => line).map(line => {
                const [name, cpu, mem, memPerc, status] = line.split('|');
                return { name, cpu, mem, memPerc, status };
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
