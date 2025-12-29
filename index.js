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

    if (!user || !spd) {
        // إرجاع صورة 1x1 شفافة حتى لو فشل
        const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
        res.set('Content-Type', 'image/gif');
        return res.send(pixel);
    }

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

    // إرجاع صورة 1x1 شفافة
    const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    res.set('Content-Type', 'image/gif');
    res.set('Cache-Control', 'no-cache, no-store');
    res.send(pixel);
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
// صفحة الحالة
// ============================================================
app.get('/', (req, res) => {
    res.send(`
        <html>
        <head>
            <title>MikroTik Speed Server</title>
            <style>
                body { font-family: Arial; background: #1a1a2e; color: #eee; padding: 20px; }
                h1 { color: #0ff; }
                .box { background: #16213e; padding: 15px; border-radius: 10px; margin: 10px 0; }
                .pending { color: #ffa500; }
                .completed { color: #0f0; }
            </style>
        </head>
        <body>
            <h1>🚀 MikroTik Speed Server</h1>
            <div class="box">
                <h3>📊 Status</h3>
                <p>Pending Commands: <span class="pending">${pendingCommands.length}</span></p>
                <p>Executed Commands: <span class="completed">${executedCommands.length}</span></p>
                <p>Server Time: ${new Date().toISOString()}</p>
            </div>
            <div class="box">
                <h3>📝 Recent Commands</h3>
                <ul>
                ${executedCommands.slice(-10).reverse().map(c =>
        `<li>${c.username} → ${c.speed} (${c.status})</li>`
    ).join('')}
                </ul>
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
