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
    
    exec("top -bn1 | grep 'Cpu(s)' | sed 's/.*, *\\([0-9.]*\\)%* id.*/\\1/' | awk '{print 100 - $1}'", (errCpu, stdoutCpu) => {
        const cpuUsage = errCpu ? 0 : parseFloat(stdoutCpu.trim());
        
        exec("df -h /hostfs | awk 'NR==2 {print $2 \"|\" $3 \"|\" $4 \"|\" $5}'", (errDisk, stdoutDisk) => {
            const diskParts = (stdoutDisk || "").trim().split('|');
            const diskInfo = diskParts.length === 4 ? {
                total: diskParts[0], used: diskParts[1], free: diskParts[2], percent: diskParts[3]
            } : { total: "0G", used: "0G", free: "0G", percent: "0%" };

            // 1. LỚP 1: Quét các ổ USB đã MOUNT (Đọc được dung lượng Đã dùng/Còn trống)
            exec("df -h | awk '$1 ~ /^\\/dev\\/sd/ {print $1 \"|\" $2 \"|\" $4}'", (errUsb, stdoutUsb) => {
                let usbList = [];
                
                if (stdoutUsb && stdoutUsb.trim()) {
                    const lines = stdoutUsb.trim().split('\n');
                    usbList = lines.map(line => {
                        const [name, total, free] = line.split('|');
                        const driveName = name.replace('/dev/', '').toUpperCase();
                        return `Đã gắn USB <b>(${driveName})</b><br>Tổng: <span class="text-clay font-bold">${total}</span> - Trống: <span class="text-clay font-bold">${free}</span>`;
                    });
                    
                    return res.json({
                        cpu: cpuUsage.toFixed(1),
                        memory: { used: (usedMem / 1024 / 1024 / 1024).toFixed(2), total: (totalMem / 1024 / 1024 / 1024).toFixed(2), percent: ((usedMem / totalMem) * 100).toFixed(1) },
                        disk: diskInfo,
                        usb: usbList
                    });
                }
                
                // 2. LỚP 2: Quét ổ chưa Mount nhưng có DUNG LƯỢNG (Dùng lsblk)
                exec("lsblk -d -n -o NAME,SIZE,MODEL | grep '^sd'", (errBlk, stdoutBlk) => {
                    if (stdoutBlk && stdoutBlk.trim()) {
                        const lines = stdoutBlk.trim().split('\n');
                        usbList = lines.map(line => {
                            const parts = line.trim().split(/\s+/);
                            const size = parts[1]; 
                            const model = parts.slice(2).join(' ') || "Generic USB"; 
                            return `Đã cắm: <b>${model}</b><br>Dung lượng phần cứng: <span class="text-clay font-bold">${size}</span> <br><span class="text-ink/60 text-[11px] mt-1 block tracking-wide">* Cần mount để xem chi tiết</span>`;
                        });
                        
                        return res.json({
                            cpu: cpuUsage.toFixed(1),
                            memory: { used: (usedMem / 1024 / 1024 / 1024).toFixed(2), total: (totalMem / 1024 / 1024 / 1024).toFixed(2), percent: ((usedMem / totalMem) * 100).toFixed(1) },
                            disk: diskInfo,
                            usb: usbList
                        });
                    }
                    
                    // 3. LỚP 3: Quét THIẾT BỊ VẬT LÝ (Dùng lsusb - Cứu cánh cuối cùng)
                    // Dành cho Đầu đọc thẻ nhớ chưa cắm thẻ, hoặc USB bị lỗi phân vùng
                    exec("lsusb", (errLs, stdoutLs) => {
                        if (stdoutLs && stdoutLs.trim()) {
                            const lines = stdoutLs.trim().split('\n');
                            const filteredLines = lines.filter(line => !/1d6b|Linux|root hub|Host Controller/i.test(line));
                            
                            usbList = filteredLines.map(line => {
                                const usbName = line.includes('ID ') ? line.split('ID ')[1] : line;
                                return `Nhận diện thiết bị: <b>${usbName}</b><br><span class="text-ink/60 text-[11px] block mt-1 leading-relaxed">* Chưa đọc được dung lượng. Nếu là đầu đọc, vui lòng kiểm tra thẻ nhớ.</span>`;
                            });
                        }
                        
                        if (usbList.length === 0) {
                            usbList = ["Không có thiết bị USB nào đang gắn"];
                        }
                        
                        res.json({
                            cpu: cpuUsage.toFixed(1),
                            memory: { used: (usedMem / 1024 / 1024 / 1024).toFixed(2), total: (totalMem / 1024 / 1024 / 1024).toFixed(2), percent: ((usedMem / totalMem) * 100).toFixed(1) },
                            disk: diskInfo,
                            usb: usbList
                        });
                    });
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
