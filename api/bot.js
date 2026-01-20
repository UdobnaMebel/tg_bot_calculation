const { Bot, webhookCallback } = require('grammy');
const Redis = require('ioredis');

const bot = new Bot(process.env.BOT_TOKEN);
// Очистка ID группы
const ADMIN_GROUP_ID = (process.env.MANAGER_CHAT_ID || '').trim().replace(/['"]/g, ''); 
const webAppUrl = process.env.WEBAPP_URL; 

const redis = new Redis(process.env.REDIS_URL); 
redis.on('error', (err) => console.error('🔴 REDIS ERROR:', err));

const KEYBOARD = {
    keyboard: [[{ text: "✅ Открыть конструктор", web_app: { url: webAppUrl } }]],
    resize_keyboard: true
};

// --- ФУНКЦИИ ТОПИКОВ (С ЛОГАМИ) ---

async function createNewTopic(user) {
    try {
        console.log(`[DEBUG] Пытаюсь создать топик для пользователя ${user.id}...`);
        
        const dateStr = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        const nameClean = `${user.first_name} ${user.last_name||''}`.trim().substring(0, 30);
        // Добавляем случайное число для уникальности, если время совпадает
        const randomId = Math.floor(Math.random() * 100);
        const topicName = `${nameClean} [${dateStr}-${randomId}]`;

        const topic = await bot.api.createForumTopic(ADMIN_GROUP_ID, topicName);
        
        console.log(`[DEBUG] ✅ Топик создан! ID: ${topic.message_thread_id}, Name: ${topicName}`);

        await redis.set(`user:${user.id}`, topic.message_thread_id);
        await redis.set(`thread:${topic.message_thread_id}`, user.id);
        
        return topic.message_thread_id;
    } catch (e) {
        // ВОТ ЗДЕСЬ ТЕПЕРЬ БУДЕТ ЛОГ ОШИБКИ В VERCEL
        console.error(`[ERROR] ❌ Ошибка создания топика: ${e.message}`, e);
        return { error: e.message };
    }
}

async function getTopicForUser(user) {
    const cachedId = await redis.get(`user:${user.id}`);
    if (cachedId) {
        // console.log(`[DEBUG] Топик найден в кэше: ${cachedId}`);
        return parseInt(cachedId);
    }
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

// --- ОТПРАВКА ---

async function sendToGroupWithRetry(text, user) {
    if (!ADMIN_GROUP_ID) return;
    
    let threadId = await getTopicForUser(user);
    if (typeof threadId === 'object' && threadId.error) {
        return await bot.api.sendMessage(ADMIN_GROUP_ID, `⚠️ <b>Ошибка (Create):</b> ${threadId.error}\n\n${text}`, { parse_mode: 'HTML' });
    }

    try {
        await bot.api.sendMessage(ADMIN_GROUP_ID, text, { parse_mode: 'HTML', message_thread_id: threadId });
    } catch (e) {
        console.error(`[ERROR] Ошибка отправки в топик ${threadId}:`, e.message);
        
        await bot.api.sendMessage(ADMIN_GROUP_ID, `♻️ Топик #${threadId} недоступен. Пересоздаю...`);
        await redis.del(`user:${user.id}`);
        if (threadId) await redis.del(`thread:${threadId}`);
        
        const newResult = await createNewTopic(user);
        if (typeof newResult === 'object' && newResult.error) {
             await bot.api.sendMessage(ADMIN_GROUP_ID, `❌ Ошибка восстановления: ${newResult.error}\n\n${text}`, { parse_mode: 'HTML' });
        } else {
             await bot.api.sendMessage(ADMIN_GROUP_ID, text, { parse_mode: 'HTML', message_thread_id: newResult });
        }
    }
}

async function copyToGroupWithRetry(ctx) {
    if (!ADMIN_GROUP_ID) return;
    const user = ctx.from;

    let threadId = await getTopicForUser(user);
    
    // Если не удалось создать топик сразу
    if (typeof threadId === 'object' && threadId.error) {
        await bot.api.sendMessage(ADMIN_GROUP_ID, `⚠️ <b>Ошибка тикета:</b> ${threadId.error}\nСообщение от ${user.first_name}:`, { parse_mode: 'HTML' });
        return await ctx.copyMessage(ADMIN_GROUP_ID); // Шлем в General
    }

    try {
        await ctx.copyMessage(ADMIN_GROUP_ID, { message_thread_id: threadId });
    } catch (e) {
        console.error(`[ERROR] Ошибка пересылки в топик ${threadId}:`, e.message);
        
        // Удаляем старые данные
        await redis.del(`user:${user.id}`);
        if (threadId) await redis.del(`thread:${threadId}`);
        
        // Пробуем создать новый
        const newResult = await createNewTopic(user);
        
        if (typeof newResult === 'object' && newResult.error) {
            // Если и новый создать не вышло - шлем в General с отчетом
            await bot.api.sendMessage(ADMIN_GROUP_ID, `❌ <b>Сбой чата:</b> ${newResult.error}\nСообщение от ${user.first_name}:`, { parse_mode: 'HTML' });
            await ctx.copyMessage(ADMIN_GROUP_ID);
        } else {
            // Шлем в новый топик
            await ctx.copyMessage(ADMIN_GROUP_ID, { message_thread_id: newResult });
        }
    }
}

// === ОБРАБОТЧИКИ ===

bot.on('message', async (ctx, next) => {
    if (ctx.message.web_app_data || ctx.message.is_automatic_forward) return next();

    const chatId = ctx.chat.id.toString();
    
    // 1. Клиент -> Бот
    if (ctx.chat.type === 'private') {
        await copyToGroupWithRetry(ctx);
    } 
    // 2. Админ -> Клиент
    else if (chatId === ADMIN_GROUP_ID && ctx.message.message_thread_id) {
        const userId = await redis.get(`thread:${ctx.message.message_thread_id}`);
        if (userId) {
            try {
                await ctx.copyMessage(userId);
            } catch (e) { console.error(`[ERROR] Не ушло клиенту ${userId}:`, e.message); }
        }
    }
    return next();
});

bot.on('message:web_app_data', async (ctx) => {
    try {
        const { data } = ctx.message.web_app_data;
        const order = JSON.parse(data);
        const user = ctx.from; 
        
        await sendToGroupWithRetry(createManagerMessage(order, user), user);
        await ctx.reply(createClientMessage(order), { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });
    } catch (e) { console.error("[ERROR] WebApp Data:", e); }
});

const handleUpdate = webhookCallback(bot, 'http');

module.exports = async (req, res) => {
    if (req.method === 'GET') return res.status(200).send('Bot Running');
    
    if (req.body?.type === 'DIRECT_ORDER') {
        const { order, user } = req.body;
        console.log(`[DEBUG] Прямой заказ от ${user.first_name}`);
        
        await sendToGroupWithRetry(createManagerMessage(order, user), user);
        
        if (user.id) {
            try {
                await bot.api.sendMessage(user.id, createClientMessage(order), { 
                    parse_mode: 'HTML', 
                    reply_markup: { remove_keyboard: true } 
                });
            } catch (e) { console.error("[ERROR] Client reply:", e.message); }
        }
        return res.status(200).json({ success: true });
    }
    
    try { return await handleUpdate(req, res); } catch (e) { 
        console.error("[CRITICAL]", e);
        return res.status(500).send('Error'); 
    }
};

bot.command('start', async (ctx) => {
    if (ctx.chat.type === 'private') await ctx.reply('👋 Конструктор готов! Нажмите кнопку ниже.', { reply_markup: KEYBOARD });
});