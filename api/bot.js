const { Bot, webhookCallback } = require('grammy');
const Redis = require('ioredis');

const bot = new Bot(process.env.BOT_TOKEN);
const ADMIN_GROUP_ID = (process.env.MANAGER_CHAT_ID || '').trim().replace(/['"]/g, ''); 
const webAppUrl = process.env.WEBAPP_URL; 

const redis = new Redis(process.env.REDIS_URL); 
redis.on('error', (err) => console.error('Redis Client Error', err));

const KEYBOARD = {
    keyboard: [[{ text: "✅ Открыть конструктор", web_app: { url: webAppUrl } }]],
    resize_keyboard: true
};

// --- УПРАВЛЕНИЕ ТОПИКАМИ ---

async function createNewTopic(user) {
    try {
        // Формируем имя: "Имя (username)"
        const name = `${user.first_name} ${user.last_name||''} (@${user.username||'no_nick'})`.trim().substring(0, 60);
        const topic = await bot.api.createForumTopic(ADMIN_GROUP_ID, name);
        
        // Сохраняем в базу
        await redis.set(`user:${user.id}`, topic.message_thread_id);
        await redis.set(`thread:${topic.message_thread_id}`, user.id);
        
        return topic.message_thread_id;
    } catch (e) {
        console.error("🔴 Не удалось создать топик:", e.message);
        return null; 
    }
}

async function getTopicForUser(user) {
    const cachedId = await redis.get(`user:${user.id}`);
    if (cachedId) return parseInt(cachedId);
    return await createNewTopic(user);
}

// --- СООБЩЕНИЯ ---

function createManagerMessage(order, user) {
    let msg = `🆕 <b>НОВЫЙ ЗАКАЗ</b>\n\n👤 <b>Клиент:</b> @${user.username||'нет'} (ID: ${user.id})\n\n📋 <b>Состав:</b>\n`;
    order.items.forEach(i => msg += `${i.name} (${i.color}) - ${i.price}\n`);
    msg += `\n💰 <b>Итого:</b> ${order.total}\n📏 ${order.dims}\n⚖️ ${order.weight.replace('Вес:', '<b>Вес:</b>')}`;
    return msg;
}

function createClientMessage(order) {
    let msg = `✅ <b>Заявка принята!</b>\nМенеджер скоро свяжется с вами.\n\n📋 <b>Заказ:</b>\n`;
    order.items.forEach(i => msg += `${i.name} (${i.color})\n`);
    msg += `\n💰 <b>Итого:</b> ${order.total}`;
    return msg;
}

// --- ОТПРАВКА С ЗАЩИТОЙ ОТ СБОЕВ ---

async function sendToGroup(text, user, extra = {}) {
    if (!ADMIN_GROUP_ID) return;
    
    // 1. Получаем ID топика
    let threadId = await getTopicForUser(user);
    
    try {
        // 2. Пробуем отправить
        await bot.api.sendMessage(ADMIN_GROUP_ID, text, { 
            parse_mode: 'HTML', 
            message_thread_id: threadId || undefined, // Если null - уйдет в General
            ...extra 
        });
    } catch (e) {
        console.log(`⚠️ Ошибка отправки в топик ${threadId}. Пробуем пересоздать...`);
        
        // 3. Если ошибка (топик удален) — чистим базу и создаем новый
        await redis.del(`user:${user.id}`);
        if (threadId) await redis.del(`thread:${threadId}`);
        
        threadId = await createNewTopic(user);
        
        // 4. Повторная попытка в новый топик
        try {
            await bot.api.sendMessage(ADMIN_GROUP_ID, text, { 
                parse_mode: 'HTML', 
                message_thread_id: threadId || undefined,
                ...extra
            });
        } catch (e2) {
            console.error("❌ Фатальная ошибка отправки в группу:", e2);
        }
    }
}

// Аналогичная функция для копирования сообщений (из лички в группу)
async function copyToGroup(ctx) {
    if (!ADMIN_GROUP_ID) return;
    const user = ctx.from;
    
    let threadId = await getTopicForUser(user);
    
    try {
        await ctx.copyMessage(ADMIN_GROUP_ID, { message_thread_id: threadId || undefined });
    } catch (e) {
        console.log("⚠️ Топик не найден. Пересоздаем...");
        await redis.del(`user:${user.id}`);
        if (threadId) await redis.del(`thread:${threadId}`);
        
        threadId = await createNewTopic(user);
        
        // Если пересоздать не вышло (threadId = null), сообщение уйдет в General
        await ctx.copyMessage(ADMIN_GROUP_ID, { message_thread_id: threadId || undefined });
    }
}

// === ОБРАБОТЧИКИ ===

// 1. Сообщения
bot.on('message', async (ctx, next) => {
    if (ctx.message.web_app_data || ctx.message.is_automatic_forward) return next();

    const chatId = ctx.chat.id.toString();
    
    // Клиент -> Бот (в личку)
    if (ctx.chat.type === 'private') {
        await copyToGroup(ctx);
    } 
    // Админ -> Клиент (в группе)
    else if (chatId === ADMIN_GROUP_ID && ctx.message.message_thread_id) {
        const userId = await redis.get(`thread:${ctx.message.message_thread_id}`);
        if (userId) {
            try {
                await ctx.copyMessage(userId);
            } catch (e) { console.error("Не удалось ответить клиенту:", e); }
        }
    }
    return next();
});

// 2. Заказы (Кнопка внизу)
bot.on('message:web_app_data', async (ctx) => {
    try {
        const { data } = ctx.message.web_app_data;
        const order = JSON.parse(data);
        const user = ctx.from; 
        
        await sendToGroup(createManagerMessage(order, user), user);
        
        await ctx.reply(createClientMessage(order), { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });
    } catch (e) { console.error(e); }
});

// 3. Прямой заказ (Меню)
const handleUpdate = webhookCallback(bot, 'http');

module.exports = async (req, res) => {
    if (req.method === 'GET') return res.status(200).send('Bot Running');
    
    if (req.body?.type === 'DIRECT_ORDER') {
        const { order, user } = req.body;
        
        // Отправка менеджеру
        await sendToGroup(createManagerMessage(order, user), user);
        
        // Отправка клиенту (если есть ID)
        if (user.id) {
            try {
                await bot.api.sendMessage(user.id, createClientMessage(order), { 
                    parse_mode: 'HTML', 
                    reply_markup: { remove_keyboard: true } 
                });
            } catch (e) {}
        }
        return res.status(200).json({ success: true });
    }
    
    try { return await handleUpdate(req, res); } 
    catch (e) { return res.status(500).send('Error'); }
};

// Start
bot.command('start', async (ctx) => {
    if (ctx.chat.type === 'private') {
        await ctx.reply('👋 Конструктор готов! Нажмите кнопку ниже.\n\n💬 Пишите сюда — менеджер ответит.', { reply_markup: KEYBOARD });
    }
});