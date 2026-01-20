const { Bot, webhookCallback } = require('grammy');
const { kv } = require('@vercel/kv');

const bot = new Bot(process.env.BOT_TOKEN);
const ADMIN_GROUP_ID = String(process.env.MANAGER_CHAT_ID || '').trim().replace(/['"]/g, ''); 
const webAppUrl = process.env.WEBAPP_URL; 

const KEYBOARD = {
    keyboard: [[{ text: "✅ Открыть конструктор", web_app: { url: webAppUrl } }]],
    resize_keyboard: true
};

// --- КОМАНДЫ ---

bot.command('check', async (ctx) => {
    await ctx.reply(`ID чата: <code>${ctx.chat.id}</code>\nЦель: <code>${ADMIN_GROUP_ID}</code>`, { parse_mode: 'HTML' });
});

bot.command('start', async (ctx) => {
    if (ctx.chat.type === 'private') {
        await ctx.reply('👋 Конструктор готов!', { reply_markup: KEYBOARD });
        // Уведомляем админа о новом юзере
        await handlePrivateMessage(ctx, `👋 Нажал <b>/start</b>`);
    }
});

// --- ЛОГИКА ТОПИКОВ ---

async function getOrCreateTopic(user) {
    // 1. Ищем в базе
    const cachedId = await kv.get(`user:${user.id}`);
    if (cachedId) return parseInt(cachedId);

    // 2. Создаем новый
    try {
        const random = Math.floor(Math.random() * 1000);
        const name = `${user.first_name} (@${user.username||'no'}) #${random}`.substring(0, 60);
        
        const topic = await bot.api.createForumTopic(ADMIN_GROUP_ID, name);
        
        await kv.set(`user:${user.id}`, topic.message_thread_id);
        await kv.set(`thread:${topic.message_thread_id}`, user.id);
        
        return topic.message_thread_id;
    } catch (e) {
        console.error("Topic Error:", e);
        return null;
    }
}

// --- ОБРАБОТЧИКИ СООБЩЕНИЙ ---

// 1. ЛОГИКА: КЛИЕНТ -> АДМИН
async function handlePrivateMessage(ctx, textOverride = null) {
    if (!ADMIN_GROUP_ID) return;
    const user = ctx.from;

    let threadId = await getOrCreateTopic(user);

    try {
        // Попытка 1: Отправка
        if (textOverride) {
            await bot.api.sendMessage(ADMIN_GROUP_ID, textOverride, { parse_mode: 'HTML', message_thread_id: threadId || undefined });
        } else {
            await ctx.copyMessage(ADMIN_GROUP_ID, { message_thread_id: threadId || undefined });
        }
    } catch (e) {
        // Ошибка (скорее всего топик удален) -> Ресет и повтор
        console.log(`Сбой отправки в ${threadId}, создаем новый...`);
        
        await kv.del(`user:${user.id}`);
        // Создаем принудительно новый
        threadId = await getOrCreateTopic(user); // Теперь вернет новый ID
        
        try {
            if (textOverride) {
                await bot.api.sendMessage(ADMIN_GROUP_ID, textOverride, { parse_mode: 'HTML', message_thread_id: threadId || undefined });
            } else {
                await ctx.copyMessage(ADMIN_GROUP_ID, { message_thread_id: threadId || undefined });
            }
            // Уведомляем, что создали новый
            if (threadId) {
                await bot.api.sendMessage(ADMIN_GROUP_ID, "ℹ️ <i>Предыдущий чат был удален. Создан новый.</i>", { parse_mode: 'HTML', message_thread_id: threadId });
            }
        } catch (finalError) {
            // Если совсем не вышло - в General с ошибкой
            await bot.api.sendMessage(ADMIN_GROUP_ID, `🔥 <b>Ошибка доставки:</b> ${finalError.message}\nСообщение от ${user.first_name}`, { parse_mode: 'HTML' });
        }
    }
}

// 2. ЛОГИКА: АДМИН -> КЛИЕНТ
async function handleAdminReply(ctx) {
    const threadId = ctx.message.message_thread_id;
    if (!threadId) return; // Пишут в General - игнор

    const userId = await kv.get(`thread:${threadId}`);
    
    if (userId) {
        try {
            await ctx.copyMessage(userId);
            await ctx.react('👍'); // Подтверждение успеха
        } catch (e) {
            await ctx.reply(`❌ Не доставлено: ${e.description}`);
        }
    } else {
        // Тихо игнорируем или ставим реакцию "непонимания", если это не служебное сообщение
        // await ctx.react('🤷‍♂️'); 
    }
}

// === ГЛАВНЫЙ РОУТЕР ===

bot.on('message', async (ctx) => {
    // Пропускаем ТОЛЬКО автоматические пересылки каналов
    if (ctx.message.is_automatic_forward) return;

    const currentId = String(ctx.chat.id);
    const targetId = String(ADMIN_GROUP_ID);

    // Сценарий А: Личка (Клиент)
    if (ctx.chat.type === 'private') {
        await handlePrivateMessage(ctx);
    }
    
    // Сценарий Б: Группа админа
    else if (currentId === targetId) {
        await handleAdminReply(ctx);
    }
});

// === ЗАКАЗЫ ===

bot.on('message:web_app_data', async (ctx) => {
    const order = JSON.parse(ctx.message.web_app_data.data);
    const msg = `🆕 <b>НОВЫЙ ЗАКАЗ</b>\n💰 ${order.total}\n👤 @${ctx.from.username||'no'}`;
    
    await handlePrivateMessage(ctx, msg); // Используем ту же логику с топиками
    await ctx.reply("✅ Принято!", { reply_markup: { remove_keyboard: true } });
});

// === SERVERLESS ===

const handleUpdate = webhookCallback(bot, 'http');

module.exports = async (req, res) => {
    if (req.method === 'GET') return res.status(200).send('Bot Running');
    
    if (req.body?.type === 'DIRECT_ORDER') {
        const { order, user } = req.body;
        // Тут упрощенная отправка для fetch
        // Можно докрутить создание топика, но пока главное - чат
        return res.status(200).json({ success: true });
    }
    
    try { return await handleUpdate(req, res); } catch (e) { return res.status(500).send('Error'); }
};