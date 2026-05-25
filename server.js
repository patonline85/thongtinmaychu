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

// Biến toàn cục để theo dõi trạng thái hệ thống
let isBackingUp = false;
let isUnmountedByUser = false; // Cờ chặn vòng lặp Auto-Mount khi user chủ động gỡ ổ

// API Lấy thông số hệ thống (CPU, RAM, Ổ cứng, USB)
app.get('/api/system', requireAuth, (req, res) => {
    // --- CHỨC NĂNG TỰ ĐỘNG DÒ VÀ MOUNT THIẾT BỊ VẠN NĂNG ---
    exec(`chroot /hostfs sh -c "lsblk -ln -o NAME,MOUNTPOINT,TYPE | grep part | grep -v mmcblk2"`, (devErr, devStdout) => {
        if (devErr || !devStdout || !devStdout.trim()) {
            isUnmountedByUser = false; 
            return;
        }

        const lines = devStdout.trim().split('\n');
        let targetPartition = null;
        let isMounted = false;

        for (let line of lines) {
            const [name, mountpoint] = line.trim().split(/\s+/);
            if (name.endsWith('2') || name.endsWith('p2')) {
                targetPartition = name;
                if (mountpoint === '/media/sdcard') isMounted = true;
                break;
            }
        }
        if (!targetPartition && lines.length > 0) {
            const [name, mountpoint] = lines[0].trim().split(/\s+/);
            targetPartition = name;
            if (mountpoint === '/media/sdcard') isMounted = true;
        }

        if (targetPartition && !isMounted && !isUnmountedByUser) {
            exec(`chroot /hostfs sh -c "mkdir -p /media/sdcard && mount /dev/${targetPartition} /media/sdcard"`);
        }
    });

    // --- QUÉT THÔNG SỐ RAM ---
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    
    // --- QUÉT CPU VÀ TOÀN BỘ Ổ ĐĨA BẰNG CHROOT ---
    exec("top -bn1 | grep 'Cpu(s)' | sed 's/.*, *\\([0-9.]*\\)%* id.*/\\1/' | awk '{print 100 - $1}'", (errCpu, stdoutCpu) => {
        const cpuUsage = errCpu ? 0 : parseFloat(stdoutCpu.trim());
        
        // Gộp chung quét Ổ hệ thống và Lớp 1 (Ổ USB đã mount) vào 1 lệnh duy nhất xuyên qua hostfs
        exec("chroot /hostfs df -h", (errDisk, stdoutDisk) => {
            let diskInfo = { total: "0G", used: "0G", free: "0G", percent: "0%" };
            let usbList = [];
            const uniqueDrives = new Map();

            if (!errDisk && stdoutDisk) {
                const dfLines = stdoutDisk.trim().split('\n');
                dfLines.forEach(line => {
                    const parts = line.trim().split(/\s+/);
                    if (parts.length >= 6) {
                        const devName = parts[0];
                        const total = parts[1];
                        const used = parts[2];
                        const free = parts[3];
                        const percent = parts[4];
                        const mount = parts[5];

                        // Đọc ổ eMMC gốc (/)
                        if (mount === '/') {
                            diskInfo = { total, used, free, percent: percent.replace('%', '') };
                        }
                        
                        // LỚP 1: Quét ổ cắm ngoài đã Auto-Mount thành công
                        if ((devName.startsWith('/dev/sd') || devName.startsWith('/dev/mmcblk')) && !devName.includes('mmcblk2')) {
                            uniqueDrives.set(devName, { total, free });
                        }
                    }
                });
            }

            if (uniqueDrives.size > 0) {
                usbList = Array.from(uniqueDrives.entries()).map(([name, data]) => {
                    const driveName = name.replace('/dev/', '').toUpperCase();
                    const typeName = driveName.includes('MMCBLK') ? 'Thẻ nhớ' : 'USB';
                    return `Đã gắn ${typeName} <b>(${driveName})</b><br>Tổng: <span class="text-clay font-bold">${data.total}</span> - Trống: <span class="text-clay font-bold">${data.free}</span>`;
                });
                return sendSystemResponse();
            }

            // LỚP 2: Quét ổ cắm vào nhưng chưa Mount (Ép dùng chroot lsblk để nhận diện cắm nóng)
            exec("chroot /hostfs lsblk -d -n -o NAME,SIZE,MODEL", (errBlk, stdoutBlk) => {
                if (!errBlk && stdoutBlk && stdoutBlk.trim()) {
                    const blkLines = stdoutBlk.trim().split('\n');
                    const validDrives = blkLines.filter(line => line.startsWith('sd') || line.startsWith('mmcblk1'));
                    
                    if (validDrives.length > 0) {
                        usbList = validDrives.map(line => {
                            const parts = line.trim().split(/\s+/);
                            const size = parts[1]; 
                            const model = parts.slice(2).join(' ') || "Thiết bị ngoại vi"; 
                            
                            const statusText = isUnmountedByUser 
                                ? `<span class="text-green-600 font-bold">✓ Đã ngắt kết nối an toàn. Có thể rút thiết bị.</span>`
                                : `* Đang tiến hành kết nối (Auto-Mount)...`;

                            return `Đã cắm: <b>${model}</b><br>Dung lượng phần cứng: <span class="text-clay font-bold">${size}</span> <br><span class="text-ink/60 text-[11px] mt-1 block tracking-wide">${statusText}</span>`;
                        });
                        return sendSystemResponse();
                    }
                }

                // LỚP 3: Quét thiết bị vật lý (Ép dùng chroot lsusb)
                exec("chroot /hostfs lsusb", (errLs, stdoutLs) => {
                    if (!errLs && stdoutLs && stdoutLs.trim()) {
                        const lsLines = stdoutLs.trim().split('\n');
                        const filteredLines = lsLines.filter(line => !/1d6b|Linux|root hub|Host Controller/i.test(line));
                        
                        usbList = filteredLines.map(line => {
                            const usbName = line.includes('ID ') ? line.split('ID ')[1] : line;
                            return `Nhận diện thiết bị: <b>${usbName}</b><br><span class="text-ink/60 text-[11px] block mt-1 leading-relaxed">* Chưa đọc được dung lượng. Nếu là đầu đọc, vui lòng kiểm tra thẻ nhớ.</span>`;
                        });
                    }

                    if (usbList.length === 0) {
                        usbList = ["Không có thiết bị USB nào đang gắn"];
                    }

                    return sendSystemResponse();
                });
            });

            // Hàm con xuất JSON gọn gàng (DRY pattern)
            function sendSystemResponse() {
                res.json({
                    isBackingUp: isBackingUp,
                    cpu: { usage: cpuUsage.toFixed(1), temp: getThermalTemp('cpu') },
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
        });
    });
});

// API Lấy thông số Docker (Thay thế ctop)
app.get('/api/docker', requireAuth, (req, res) => {
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

// API Kích hoạt Backup (Đồng bộ Rsync sang thiết bị ngoài)
app.post('/api/backup', requireAuth, (req, res) => {
    if (isBackingUp) return res.status(400).json({ success: false, error: "Hệ thống đang đồng bộ!" });
    isBackingUp = true;
    res.json({ success: true, message: "Đã kích hoạt đồng bộ ngầm!" });

    // Đã thêm lệnh ném log vào /dev/null và lệnh ÉP XẢ RAM (drop_caches) ở dòng cuối
    const backupCommand = `
        TARGET_DEV=$(chroot /hostfs sh -c "df | grep /media/sdcard | awk '{print \\$1}'") && \
        if [ ! -z "$TARGET_DEV" ]; then chroot /hostfs mount -o remount,rw $TARGET_DEV; fi && \
        chroot /hostfs rsync -aAXxHS --delete --exclude='/dev/*' --exclude='/proc/*' --exclude='/sys/*' --exclude='/tmp/*' --exclude='/run/*' --exclude='/mnt/*' --exclude='/media/*' --exclude='/lost+found' / /media/sdcard/ > /dev/null 2>&1 && \
        if [ ! -z "$TARGET_DEV" ]; then chroot /hostfs mount -o remount,ro $TARGET_DEV; fi && \
        chroot /hostfs sh -c "sync; echo 1 > /proc/sys/vm/drop_caches"
    `;

    exec(backupCommand, (err) => {
        isBackingUp = false;
        if (err) console.error("Lỗi Backup:", err.message);
        else console.log("✅ Backup hoàn tất. Đã ép hệ thống xả 100% RAM đệm!");
    });
});

// API Ngắt kết nối an toàn (Unmount vạn năng - Bản tối ưu cờ chặn)
app.post('/api/unmount', requireAuth, (req, res) => {
    isUnmountedByUser = true; // KÍCH HOẠT BIỂN CẤM: Khóa ngay lập tức lệnh Auto-Mount tự động

    const unmountCommand = `
        chroot /hostfs sh -c "
            sync;
            umount -fl /media/sdcard 2>/dev/null; 
            umount -fl /dev/sda1 2>/dev/null; 
            umount -fl /dev/sda2 2>/dev/null; 
            umount -fl /dev/mmcblk1p1 2>/dev/null; 
            umount -fl /dev/mmcblk1p2 2>/dev/null; 
            exit 0
        "
    `;

    exec(unmountCommand, (err, stdout, stderr) => {
        if (err) {
            isUnmountedByUser = false; // Trả lại cờ nếu lệnh thất bại thật sự
            console.error("⛔ Lỗi Unmount:", err.message);
            return res.status(500).json({ success: false, error: "Không thể ngắt kết nối. Vui lòng thử lại." });
        }
        res.json({ success: true, message: "Đã ngắt kết nối an toàn!" });
    });
});

// Phục vụ giao diện Web
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
    console.log(`📡 Server Monitor đang chạy tại cổng ${PORT}`);
});
