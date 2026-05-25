const express = require('express');
const { exec } = require('child_process');
const session = require('express-session');
const dotenv = require('dotenv');
const path = require('path');
const os = require('os');
const fs = require('fs');

function getThermalTemp(keyword) {
    try {
        const thermalDir = '/sys/class/thermal/';
        if (!fs.existsSync(thermalDir)) return "N/A";
        
        const zones = fs.readdirSync(thermalDir).filter(f => f.startsWith('thermal_zone'));
        for (const zone of zones) {
            const typePath = `${thermalDir}${zone}/type`;
            if (fs.existsSync(typePath)) {
                const type = fs.readFileSync(typePath, 'utf8').trim().toLowerCase();
                if (type.includes(keyword)) {
                    const temp = fs.readFileSync(`${thermalDir}${zone}/temp`, 'utf8');
                    return (parseInt(temp, 10) / 1000).toFixed(1);
                }
            }
        }
    } catch (e) {}
    return "N/A";
}

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

            // 1. LỚP 1: Quét ổ lưu trữ ĐÃ MOUNT (Loại bỏ ổ OS mmcblk2 và lọc trùng lặp)
            exec("df -h | awk '($1 ~ /^\\/dev\\/sd/ || $1 ~ /^\\/dev\\/mmcblk/) && $1 !~ /mmcblk2/ {print $1 \"|\" $2 \"|\" $4}'", (errUsb, stdoutUsb) => {
                let usbList = [];
                
                if (stdoutUsb && stdoutUsb.trim()) {
                    const lines = stdoutUsb.trim().split('\n');
                    
                    // Sử dụng Map để lọc bỏ các phân vùng bị lặp do mount ảo của Docker/Linux
                    const uniqueDrives = new Map();
                    lines.forEach(line => {
                        const [name, total, free] = line.split('|');
                        if (name && !uniqueDrives.has(name)) {
                            uniqueDrives.set(name, { total, free });
                        }
                    });
                    
                    // Tạo danh sách hiển thị UI
                    usbList = Array.from(uniqueDrives.entries()).map(([name, data]) => {
                        const driveName = name.replace('/dev/', '').toUpperCase();
                        // Nếu là mmcblk thì gọi là Thẻ nhớ, nếu là sd thì gọi là USB
                        const typeName = driveName.includes('MMCBLK') ? 'Thẻ nhớ' : 'USB';
                        
                        return `Đã gắn ${typeName} <b>(${driveName})</b><br>Tổng: <span class="text-clay font-bold">${data.total}</span> - Trống: <span class="text-clay font-bold">${data.free}</span>`;
                    });
                    
                    return res.json({
                        cpu: {
                            usage: cpuUsage.toFixed(1),
                            temp: getThermalTemp('cpu')
                        },
                        memory: {
                            used: (usedMem / 1024 / 1024 / 1024).toFixed(2),
                            total: (totalMem / 1024 / 1024 / 1024).toFixed(2),
                            percent: ((usedMem / totalMem) * 100).toFixed(1),
                            temp: getThermalTemp('ddr')
                        },
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
                            cpu: {
                                usage: cpuUsage.toFixed(1),
                                temp: getThermalTemp('cpu')
                            },
                            memory: {
                                used: (usedMem / 1024 / 1024 / 1024).toFixed(2),
                                total: (totalMem / 1024 / 1024 / 1024).toFixed(2),
                                percent: ((usedMem / totalMem) * 100).toFixed(1),
                                temp: getThermalTemp('ddr')
                            },
                            disk: diskInfo,
                            usb: usbList
                        });
                    }
                    
                    // 3. LỚP 3: Quét THIẾT BỊ VẬT LÝ (Dùng lsusb - Cứu cánh cuối cùng)
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
                            cpu: {
                                usage: cpuUsage.toFixed(1),
                                temp: getThermalTemp('cpu')
                            },
                            memory: {
                                used: (usedMem / 1024 / 1024 / 1024).toFixed(2),
                                total: (totalMem / 1024 / 1024 / 1024).toFixed(2),
                                percent: ((usedMem / totalMem) * 100).toFixed(1),
                                temp: getThermalTemp('ddr')
                            },
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

// API Kích hoạt Backup (Đồng bộ Rsync sang thẻ nhớ)
app.post('/api/backup', requireAuth, (req, res) => {
    // 1. Bỏ sudo vì container đã là root
    // 2. Trỏ đường dẫn vào /hostfs để backup đúng máy chủ Host
    const backupCommand = `
        mount -o remount,rw /hostfs/media/sdcard && \
        rsync -aAX --delete --exclude=/hostfs/dev/* --exclude=/hostfs/proc/* --exclude=/hostfs/sys/* --exclude=/hostfs/tmp/* --exclude=/hostfs/run/* --exclude=/hostfs/mnt/* --exclude=/hostfs/media/* --exclude=/hostfs/lost+found /hostfs/ /hostfs/media/sdcard/ && \
        mount -o remount,ro /hostfs/media/sdcard
    `;

    exec(backupCommand, (err, stdout, stderr) => {
        if (err) {
            console.error("⛔ Lỗi Backup:", err.message);
            return res.status(500).json({ success: false, error: "Đồng bộ thất bại. Vui lòng kiểm tra thẻ nhớ." });
        }
        res.json({ success: true, message: "Đồng bộ dữ liệu thành công!" });
    });
});

// API Ngắt kết nối an toàn (Unmount)
app.post('/api/unmount', requireAuth, (req, res) => {
    // Bỏ sudo và trỏ tới /hostfs
    exec("umount /hostfs/media/sdcard", (err, stdout, stderr) => {
        if (err) {
            console.error("⛔ Lỗi Unmount:", err.message);
            return res.status(500).json({ success: false, error: "Không thể ngắt kết nối. Có thể thiết bị đang bận." });
        }
        res.json({ success: true, message: "Đã ngắt kết nối an toàn!" });
    });
});

// Phục vụ giao diện Web
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
    console.log(`📡 Server Monitor đang chạy tại cổng ${PORT}`);
});
