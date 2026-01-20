const { Bot, webhookCallback } = require('grammy');
const Redis = require('ioredis');

const bot = new Bot(process.env.BOT_TOKEN);
// Получаем ID как есть, без очистки, чтобы проверить наверняка
const ADMIN_GROUP_ID = process.env.MANAGER_CHAT_ID; 
const webAppUrl = process.env.WEBAPP_URL; 

const redis = new Redis(process.env.REDIS_URL); 
redis.on('error', (err) => console.error('Redis Error', err));

const KEYBOARD = {
    keyboard: [[{ text: "✅ Открыть конструктор", web_app: { url: webAppUrl } }]],
    resize_keyboard: true
};

// --- ДИАГНОСТИКА (Самое важное) ---
// Этот блок стоит ПЕРЕД всем остальным. Он сработает всегда.
bot.command('ping', async (ctx) => {
    const chatId = ctx.chat.id;
    const threadId = ctx.message.message_thread_id || 'Нет (General)';
    const type = ctx.chat.type;
    
    // Сравниваем то, что видит бот, с тем, что в Vercel
    const configId = ADMIN_GROUP_ID;
    const isMatch = String(chatId) === String(configId);

    await ctx.reply(
        `🤖 <b>ДИАГНОСТИКА</b>\n\n` +
        `📍 <b>ID этого чата:</b> <code>${chatId}</code>\n` +
        `⚙️ <b>ID в Vercel:</b> <code>${configId}</code>\n` +
        `🧵 <b>Thread ID:</b> ${threadId}\n` +
        `❓ <b>Совпадают?</b> ${isMatch ? '✅ ДА' : '❌ НЕТ'}\n\n` +
        `Если "НЕТ" — скопируйте "ID этого чата" и вставьте в Vercel.`,
        { parse_mode: 'HTML' }
    );
});

// --- ДАЛЬШЕ СТАНДАРТНАЯ ЛОГИКА ---

async function getOrCreateTopic(user) {
    const userId = user.id;
    const existing = await redis.get(`user:${userId}`);
    if (existing) return parseInt(existing);

    try {
        const name = `${user.first_name} ${user.last_name||''} (@${user.username||''})`.substring(0,60);
        const topic = await bot.api.createForumTopic(ADMIN_GROUP_ID, name);
        await redis.set(`user:${userId}`, topic.message_thread_id);
        await redis.set(`thread:${topic.message_thread_id}`, userId);
        return topic.message_thread_id;
    } catch (e) { return null; }
}

async function sendOrder(order, user) {
    let msg = `🆕 <b>НОВЫЙ ЗАКАЗ</b>\n\n💰 <b>${order.total}</b>\n`;
    order.items.forEach(i => msg += `${i.name}\n`);
    
    if (ADMIN_GROUP_ID) {
        const threadId = await getOrCreateTopic(user);
        await bot.api.sendMessage(ADMIN_GROUP_ID, msg, { parse_mode: 'HTML', message_thread_id: threadId });
    }
}

// Пересылка сообщений
bot.on('message', async (ctx, next) => {
    if (ctx.message.web_app_data) return next(); // Пропуск для заказа

    const chatId = ctx.chat.id.toString();
    const targetId = (ADMIN_GROUP_ID || '').toString().trim();

    // 1. Клиент -> Админ
    if (ctx.chat.type === 'private') {
        const threadId = await getOrCreateTopic(ctx.from);
        if (targetId && threadId) {
            await ctx.copyMessage(targetId, { message_thread_id: threadId });
        }
    }
    // 2. Админ -> Клиент
    else if (chatId === targetId && ctx.message.message_thread_id) {
        const userId = await redis.get(`thread:${ctx.message.message_thread_id}`);
        if (userId) {
            await ctx.copyMessage(userId);
            await ctx.react('👍'); // Ставим лайк, если ушло
        }
    }
    return next();
});

// Заказ
bot.on('message:web_app_data', async (ctx) => {
    const order = JSON.parse(ctx.message.web_app_data.data);
    await sendOrder(order, ctx.from);
    await ctx.reply('✅ Принято!', { reply_markup: { remove_keyboard: true } });
});

bot.command('start', async (ctx) => {
    if (ctx.chat.type === 'private') await ctx.reply('👋', { reply_markup: KEYBOARD });
});

const handleUpdate = webhookCallback(bot, 'http');
module.exports = async (req, res) => {
    if (req.method === 'GET') return res.status(200).send('Running');
    if (req.body?.type === 'DIRECT_ORDER') {
        await sendOrder(req.body.order, req.body.user);
        // Тут можно добавить отправку клиенту по ID
        return res.status(200).json({ success: true });
    }
    return await handleUpdate(req, res);
};