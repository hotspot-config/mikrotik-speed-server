const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ============================================================
// قاعدة بيانات مؤقتة للطلبات (في الذاكرة)
// ============================================================
const pendingCommands = [];  // طلبات تنتظر التنفيذ
const executedCommands = []; // طلبات تم تنفيذها (للسجلات)
let activeUsers = [];        // المستخدمين النشطين (يرسلها الراوتر)
let routerStats = { cpu: 0, memory: 0, uptime: '0s', lastUpdate: null }; // إحصائيات الراوتر
const userSpeeds = {};       // آخر سرعة لكل مستخدم (للحفظ بين إعادة التشغيل)
const lastCommandTime = {};  // آخر وقت إرسال أمر لكل مستخدم (للحماية من التكرار)

// مفتاح أمني بسيط للـ MikroTik
const ROUTER_SECRET = process.env.ROUTER_SECRET || 'mikrotik-secret-key-2024';

// ============================================================
// API من صفحة Login/Status - لإضافة طلب سرعة جديد (POST)
// ============================================================
app.post('/api/speed/request', (req, res) => {
    const { username, speed, ip } = req.body;

    if (!username || !speed) {
        return res.json({ success: false, error: 'Missing username or speed' });
    }

    // إضافة الطلب للقائمة
    const command = {
        id: Date.now(),
        type: 'set-speed',
        username: username,
        speed: speed,
        ip: ip || null,
        createdAt: new Date().toISOString(),
        status: 'pending'
    };

    pendingCommands.push(command);

    // حفظ آخر سرعة للمستخدم
    userSpeeds[username] = speed;

    console.log(`📝 New speed request: ${username} → ${speed} (saved)`);

    res.json({
        success: true,
        message: 'Speed request queued',
        commandId: command.id
    });
});

// ============================================================
// API للـ Image Beacon - GET request (يتجاوز CORS و Mixed Content)
// ============================================================
app.get('/api/speed/set', (req, res) => {
    const { username, speed, u, s } = req.query;
    const user = username || u;
    const spd = speed || s;

    // إرجاع صورة 1x1 شفافة
    const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

    if (!user || !spd) {
        res.set('Content-Type', 'image/gif');
        return res.send(pixel);
    }

    // التحقق من التكرار - إذا أُرسل أمر لنفس المستخدم خلال 10 ثوانٍ، تجاهله
    const now = Date.now();
    const lastTime = lastCommandTime[user] || 0;
    if (now - lastTime < 10000) {
        console.log(`⏳ [GET] Skipping duplicate: ${user} → ${spd} (too soon)`);
        res.set('Content-Type', 'image/gif');
        res.set('Cache-Control', 'no-cache, no-store');
        return res.send(pixel);
    }

    // تسجيل وقت الأمر
    lastCommandTime[user] = now;

    // إضافة الطلب للقائمة
    const command = {
        id: Date.now(),
        type: 'set-speed',
        username: user,
        speed: spd,
        createdAt: new Date().toISOString(),
        status: 'pending'
    };

    pendingCommands.push(command);

    // حفظ آخر سرعة للمستخدم
    userSpeeds[user] = spd;

    console.log(`📝 [GET] Speed request: ${user} → ${spd} (saved)`);

    res.set('Content-Type', 'image/gif');
    res.set('Cache-Control', 'no-cache, no-store');
    res.send(pixel);
});

// ============================================================
// API للـ On-Login Script - يسأل عن السرعة المطلوبة للمستخدم
// ============================================================
app.get('/api/onlogin', (req, res) => {
    const { username, u, secret } = req.query;
    const user = username || u;

    // التحقق من المفتاح (اختياري للأمان)
    if (secret && secret !== ROUTER_SECRET) {
        return res.send('2M'); // سرعة افتراضية عند فشل المصادقة
    }

    if (!user) {
        return res.send('2M'); // سرعة افتراضية
    }

    // البحث عن السرعة المحفوظة للمستخدم
    const savedSpeed = userSpeeds[user];

    if (savedSpeed) {
        console.log(`🔄 [OnLogin] User ${user} → ${savedSpeed}`);
        res.send(savedSpeed); // إرجاع السرعة (1M, 2M, 4M, 8M, Unlimited)
    } else {
        console.log(`🔄 [OnLogin] User ${user} → 2M (default)`);
        res.send('2M'); // سرعة افتراضية
    }
});

// ============================================================
// API للـ MikroTik - لجلب الطلبات الجديدة
// ============================================================
app.get('/api/router/commands', (req, res) => {
    const secret = req.query.secret || req.headers['x-router-secret'];

    // التحقق من المفتاح الأمني
    if (secret !== ROUTER_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    // إرجاع الطلبات المعلقة
    const commands = [...pendingCommands];

    // مسح الطلبات بعد إرسالها
    pendingCommands.length = 0;

    if (commands.length > 0) {
        console.log(`📤 Sent ${commands.length} commands to router`);
        // حفظ في السجلات
        commands.forEach(cmd => {
            cmd.status = 'sent';
            cmd.sentAt = new Date().toISOString();
            executedCommands.push(cmd);
        });
    }

    res.json({
        success: true,
        commands: commands,
        timestamp: new Date().toISOString()
    });
});

// ============================================================
// API للـ MikroTik - لتأكيد تنفيذ الأمر
// ============================================================
app.post('/api/router/confirm', (req, res) => {
    const secret = req.query.secret || req.headers['x-router-secret'];

    if (secret !== ROUTER_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { commandId, success, error } = req.body;

    // تحديث حالة الأمر
    const cmd = executedCommands.find(c => c.id === commandId);
    if (cmd) {
        cmd.status = success ? 'completed' : 'failed';
        cmd.completedAt = new Date().toISOString();
        if (error) cmd.error = error;
    }

    console.log(`✅ Command ${commandId} ${success ? 'completed' : 'failed'}`);

    res.json({ success: true });
});

// ============================================================
// API للـ MikroTik - لإرسال قائمة المتصلين النشطين
// ============================================================
app.post('/api/router/users', (req, res) => {
    const secret = req.query.secret || req.headers['x-router-secret'];

    if (secret !== ROUTER_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { users, stats } = req.body;

    if (users && Array.isArray(users)) {
        activeUsers = users;
        console.log(`👥 Received ${users.length} active users from router`);

        // التحقق من السرعات المحفوظة وتطبيقها
        users.forEach(user => {
            const savedSpeed = userSpeeds[user.username];
            if (savedSpeed && savedSpeed !== user.speed && user.speed !== savedSpeed) {
                // السرعة المحفوظة مختلفة عن الحالية - أرسل أمر تغيير
                const existingCmd = pendingCommands.find(c => c.username === user.username && c.type === 'set-speed');
                if (!existingCmd) {
                    const command = {
                        id: Date.now() + Math.random(),
                        type: 'set-speed',
                        username: user.username,
                        speed: savedSpeed,
                        createdAt: new Date().toISOString(),
                        status: 'pending'
                    };
                    pendingCommands.push(command);
                    console.log(`🔄 Auto-restore speed: ${user.username} → ${savedSpeed}`);
                }
            }

            // إذا المستخدم ليس له Queue → اطرده ليختار السرعة
            if (user.speed === 'NoQueue' || user.speed === '2M-Auto') {
                const existingDisconnect = pendingCommands.find(c => c.username === user.username && c.type === 'disconnect');
                if (!existingDisconnect) {
                    const command = {
                        id: Date.now() + Math.random(),
                        type: 'disconnect',
                        username: user.username,
                        reason: 'NoQueue',
                        createdAt: new Date().toISOString(),
                        status: 'pending'
                    };
                    pendingCommands.push(command);
                    console.log(`🚫 Auto-disconnect (NoQueue): ${user.username}`);
                }
            }
        });
    }

    if (stats) {
        routerStats = { ...stats, lastUpdate: new Date().toISOString() };
    }

    res.json({ success: true, usersCount: activeUsers.length });
});

// ============================================================
// API للداشبورد - لجلب المتصلين النشطين
// ============================================================
app.get('/api/users', (req, res) => {
    res.json({
        success: true,
        users: activeUsers,
        stats: routerStats,
        timestamp: new Date().toISOString()
    });
});

// ============================================================
// API للداشبورد - لقطع اتصال مستخدم
// ============================================================
app.post('/api/user/disconnect', (req, res) => {
    const { username } = req.body;

    if (!username) {
        return res.json({ success: false, error: 'Missing username' });
    }

    // إضافة أمر قطع الاتصال
    const command = {
        id: Date.now(),
        type: 'disconnect',
        username: username,
        createdAt: new Date().toISOString(),
        status: 'pending'
    };

    pendingCommands.push(command);
    console.log(`🔌 Disconnect request: ${username}`);

    res.json({ success: true, message: 'Disconnect command queued' });
});

// ============================================================
// API للداشبورد - لجلب الإحصائيات
// ============================================================
app.get('/api/stats', (req, res) => {
    res.json({
        success: true,
        stats: routerStats,
        pendingCommands: pendingCommands.length,
        executedCommands: executedCommands.length,
        activeUsers: activeUsers.length,
        recentCommands: executedCommands.slice(-20).reverse()
    });
});

// ============================================================
// صفحة لوحة الإحصائيات المتقدمة
// ============================================================
app.get('/', (req, res) => {
    // حساب توزيع السرعات
    const speedDist = { '1M': 0, '2M': 0, '4M': 0, '8M': 0, 'Unlimited': 0, 'NoQueue': 0 };
    activeUsers.forEach(u => {
        if (speedDist.hasOwnProperty(u.speed)) {
            speedDist[u.speed]++;
        } else {
            speedDist['NoQueue']++;
        }
    });

    // تنسيق الذاكرة
    const formatMemory = (bytes) => {
        if (!bytes || bytes === 0) return '0 MB';
        const mb = bytes / (1024 * 1024);
        if (mb >= 1024) {
            return (mb / 1024).toFixed(1) + ' GB';
        }
        return mb.toFixed(0) + ' MB';
    };

    const memoryDisplay = formatMemory(routerStats.memory);
    const memoryPercent = routerStats.memoryPercent || 0;

    res.send(`
<!DOCTYPE html>
<html dir="rtl">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>🚀 MikroTik Speed Server</title>
    <meta http-equiv="refresh" content="5">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: 'Segoe UI', Tahoma, sans-serif; 
            background: linear-gradient(135deg, #0a0a0f 0%, #1a1a2e 100%); 
            color: #eee; 
            min-height: 100vh;
            padding: 20px;
        }
        .container { max-width: 1200px; margin: 0 auto; }
        h1 { 
            color: #0ff; 
            font-size: 2em;
            text-align: center;
            margin-bottom: 20px;
            text-shadow: 0 0 20px rgba(0,255,255,0.5);
        }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 15px; margin-bottom: 20px; }
        .card { 
            background: rgba(22,33,62,0.9); 
            padding: 20px; 
            border-radius: 15px; 
            border: 1px solid rgba(0,255,255,0.2);
            backdrop-filter: blur(10px);
        }
        .card h3 { color: #0ff; margin-bottom: 15px; font-size: 1.1em; }
        .stat-big { font-size: 3em; font-weight: bold; color: #fff; text-align: center; }
        .stat-label { text-align: center; color: #888; margin-top: 5px; }
        .stat-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,0.1); }
        .stat-row:last-child { border: none; }
        .stat-value { color: #0ff; font-weight: bold; }
        .speed-bar { 
            display: flex; 
            align-items: center; 
            gap: 10px; 
            margin: 8px 0;
        }
        .speed-name { width: 80px; font-size: 0.9em; }
        .speed-fill { 
            flex: 1; 
            height: 25px; 
            border-radius: 12px; 
            display: flex;
            align-items: center;
            justify-content: flex-end;
            padding-right: 10px;
            font-weight: bold;
            font-size: 0.9em;
            min-width: 30px;
        }
        .speed-1m { background: linear-gradient(90deg, #00ff88, #00aa55); }
        .speed-2m { background: linear-gradient(90deg, #00ccff, #0088aa); }
        .speed-4m { background: linear-gradient(90deg, #aa00ff, #7700aa); }
        .speed-8m { background: linear-gradient(90deg, #ff0088, #aa0055); }
        .speed-unlimited { background: linear-gradient(90deg, #ffcc00, #ff9900); }
        .speed-noqueue { background: linear-gradient(90deg, #666, #444); }
        .user-list { max-height: 300px; overflow-y: auto; }
        .user-item { 
            display: flex; 
            justify-content: space-between; 
            padding: 10px;
            background: rgba(0,0,0,0.3);
            margin: 5px 0;
            border-radius: 8px;
        }
        .user-name { color: #fff; }
        .user-speed { 
            padding: 3px 10px; 
            border-radius: 10px; 
            font-size: 0.8em;
            font-weight: bold;
        }
        .s-1m { background: #00ff88; color: #000; }
        .s-2m { background: #00ccff; color: #000; }
        .s-4m { background: #aa00ff; color: #fff; }
        .s-8m { background: #ff0088; color: #fff; }
        .s-unlimited { background: #ffcc00; color: #000; }
        .s-noqueue { background: #666; color: #fff; }
        .cmd-list { max-height: 200px; overflow-y: auto; }
        .cmd-item { 
            padding: 8px;
            background: rgba(0,0,0,0.3);
            margin: 5px 0;
            border-radius: 8px;
            font-size: 0.9em;
        }
        .cmd-type { color: #0ff; }
        .progress-bar { 
            background: rgba(0,0,0,0.3); 
            border-radius: 10px; 
            height: 20px; 
            overflow: hidden;
            margin-top: 5px;
        }
        .progress-fill { 
            height: 100%; 
            border-radius: 10px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 0.8em;
            font-weight: bold;
        }
        .cpu-fill { background: linear-gradient(90deg, #00ff88, #ff8800); }
        .mem-fill { background: linear-gradient(90deg, #00ccff, #ff00cc); }
        .footer { 
            text-align: center; 
            color: #666; 
            margin-top: 20px;
            font-size: 0.9em;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🚀 MikroTik Speed Server</h1>
        
        <div class="grid">
            <!-- إجمالي المتصلين -->
            <div class="card">
                <h3>👥 إجمالي المتصلين</h3>
                <div class="stat-big">${activeUsers.length}</div>
                <div class="stat-label">مستخدم نشط</div>
            </div>
            
            <!-- إحصائيات الراوتر -->
            <div class="card">
                <h3>� إحصائيات الراوتر</h3>
                <div class="stat-row">
                    <span>🖥️ CPU</span>
                    <span class="stat-value">${routerStats.cpu || 0}%</span>
                </div>
                <div class="progress-bar">
                    <div class="progress-fill cpu-fill" style="width: ${routerStats.cpu || 0}%">${routerStats.cpu || 0}%</div>
                </div>
                <div class="stat-row" style="margin-top: 15px;">
                    <span>💾 الذاكرة</span>
                    <span class="stat-value">${memoryDisplay}</span>
                </div>
                <div class="progress-bar">
                    <div class="progress-fill mem-fill" style="width: ${Math.min(memoryPercent, 100)}%">${memoryPercent}%</div>
                </div>
                <div class="stat-row" style="margin-top: 10px;">
                    <span>⏱️ وقت التشغيل</span>
                    <span class="stat-value">${routerStats.uptime || 'N/A'}</span>
                </div>
            </div>
            
            <!-- الأوامر -->
            <div class="card">
                <h3>📋 الأوامر</h3>
                <div class="stat-row">
                    <span>⏳ قيد الانتظار</span>
                    <span class="stat-value" style="color: #ffa500;">${pendingCommands.length}</span>
                </div>
                <div class="stat-row">
                    <span>✅ تم التنفيذ</span>
                    <span class="stat-value" style="color: #0f0;">${executedCommands.length}</span>
                </div>
                <div class="stat-row">
                    <span>🔑 السرعات المحفوظة</span>
                    <span class="stat-value">${Object.keys(userSpeeds).length}</span>
                </div>
            </div>
        </div>
        
        <div class="grid">
            <!-- توزيع السرعات -->
            <div class="card">
                <h3>📊 توزيع السرعات</h3>
                <div class="speed-bar">
                    <span class="speed-name">🐢 1M</span>
                    <div class="speed-fill speed-1m" style="width: ${activeUsers.length ? (speedDist['1M'] / activeUsers.length * 100) : 0}%">${speedDist['1M']}</div>
                </div>
                <div class="speed-bar">
                    <span class="speed-name">🚗 2M</span>
                    <div class="speed-fill speed-2m" style="width: ${activeUsers.length ? (speedDist['2M'] / activeUsers.length * 100) : 0}%">${speedDist['2M']}</div>
                </div>
                <div class="speed-bar">
                    <span class="speed-name">🚀 4M</span>
                    <div class="speed-fill speed-4m" style="width: ${activeUsers.length ? (speedDist['4M'] / activeUsers.length * 100) : 0}%">${speedDist['4M']}</div>
                </div>
                <div class="speed-bar">
                    <span class="speed-name">⚡ 8M</span>
                    <div class="speed-fill speed-8m" style="width: ${activeUsers.length ? (speedDist['8M'] / activeUsers.length * 100) : 0}%">${speedDist['8M']}</div>
                </div>
                <div class="speed-bar">
                    <span class="speed-name">♾️ لامحدود</span>
                    <div class="speed-fill speed-unlimited" style="width: ${activeUsers.length ? (speedDist['Unlimited'] / activeUsers.length * 100) : 0}%">${speedDist['Unlimited']}</div>
                </div>
                <div class="speed-bar">
                    <span class="speed-name">⚠️ بدون</span>
                    <div class="speed-fill speed-noqueue" style="width: ${activeUsers.length ? (speedDist['NoQueue'] / activeUsers.length * 100) : 0}%">${speedDist['NoQueue']}</div>
                </div>
            </div>
            
            <!-- المتصلين -->
            <div class="card">
                <h3>� المتصلين النشطين</h3>
                <div class="user-list">
                    ${activeUsers.length > 0 ? activeUsers.map(u => `
                        <div class="user-item">
                            <span class="user-name">${u.username}</span>
                            <span class="user-speed s-${(u.speed || 'noqueue').toLowerCase().replace('m', 'm').replace('unlimited', 'unlimited')}">${u.speed || 'NoQueue'}</span>
                        </div>
                    `).join('') : '<p style="color:#666;text-align:center;">لا يوجد متصلين</p>'}
                </div>
            </div>
        </div>
        
        <!-- آخر الأوامر -->
        <div class="card">
            <h3>📝 آخر الأوامر</h3>
            <div class="cmd-list">
                ${executedCommands.slice(-10).reverse().map(c => `
                    <div class="cmd-item">
                        <span class="cmd-type">${c.type === 'set-speed' ? '⚡' : '🚫'}</span>
                        ${c.username} → ${c.speed || 'disconnect'} 
                        <span style="color:#666;font-size:0.8em;">(${c.status})</span>
                    </div>
                `).join('') || '<p style="color:#666;text-align:center;">لا توجد أوامر</p>'}
            </div>
        </div>
        
        <div class="footer">
            🕐 آخر تحديث: ${new Date().toLocaleString('ar-SA')} | 
            📡 آخر اتصال بالراوتر: ${routerStats.lastUpdate ? new Date(routerStats.lastUpdate).toLocaleString('ar-SA') : 'لم يتصل بعد'}
        </div>
    </div>
</body>
</html>
    `);
});

// ============================================================
// بدء السيرفر
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🔑 Router Secret: ${ROUTER_SECRET}`);
});
