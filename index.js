const express = require('express');kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ============================================================
// قاعدة بيانات مؤقتة للطلبات (في الذاكرة)
// ============================================================
const pendingCommands = [];  // طلبات تنتظر التنفيذ
const executedCommands = []; // طلبات تم تنفيذها (للسجلات)

// مفتاح أمني بسيط للـ MikroTik
const ROUTER_SECRET = process.env.ROUTER_SECRET || 'mikrotik-secret-key-2024';

// ============================================================
// API من صفحة Login/Status - kkkلإضافة طلب سرعة جديد
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

    console.log(`📝 New speed request: ${username} → ${speed}`);

    res.json({
        success: true,
        message: 'Speed request queued',
        commandId: command.id
    });
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


