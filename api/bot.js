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

// --- ФУНКЦИИ УПРАВЛЕНИЯ ТОПИКАМИ ---

async function createNewTopic(user) {
    try {
        // Формируем имя: "Имя (дата)" чтобы избежать дублей
        // Telegram не любит, когда пересоздают топики с одним именем слишком часто
        const dateStr = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        const nameClean = `${user.first_name} ${user.last_name||''}`.trim().substring(0, 30);
        const topicName = `${nameClean} (${dateStr})`;

        const topic = await bot.api.createForumTopic(ADMIN_GROUP_ID, topicName);
        
        // Сохраняем в базу
        await redis.set(`user:${user.id}`, topic.message_thread_id);
        await redis.set(`thread:${topic.message_thread_id}`, user.id);
        
        return topic.message_thread_id;
    } catch (e) {
        console.error("🔴 Ошибка создания топика:", e.message);
        // Возвращаем null и ТЕКСТ ошибки, чтобы отправить его админу
        return { error: e.message }; 
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

// --- ОТПРАВКА С ВОССТАНОВЛЕНИЕМ ---

async function sendToGroup(text, user) {
    if (!ADMIN_GROUP_ID) return;
    
    let result = await getTopicForUser(user);
    let threadId = (typeof result === 'object' && result?.error) ? null : result;
    
    // Если сразу не удалось создать топик (ошибка), припишем её к тексту
    let errorPrefix = result?.error ? `⚠️ <b>Ошибка создания топика:</b> ${result.error}\n\n` : '';

    try {
        await bot.api.sendMessage(ADMIN_GROUP_ID, errorPrefix + text, { 
            parse_mode: 'HTML', 
            message_thread_id: threadId || undefined 
        });
    } catch (e) {
        // Если ошибка при отправке (например, топик был удален)
        console.log(`⚠️ Топик ${threadId} недоступен. Пересоздаем...`);
        
        await redis.del(`user:${user.id}`);
        if (threadId) await redis.del(`thread:${threadId}`);
        
        // Пробуем создать новый
        result = await createNewTopic(user);
        threadId = (typeof result === 'object' && result?.error) ? null : result;
        
        // Если и во второй раз ошибка
        errorPrefix = result?.error ? `⚠️ <b>Не удалось восстановить топик:</b> ${result.error}\n\n` : `♻️ <b>Топик восстановлен</b>\n\n`;

        // Шлем куда получится (в новый топик или в General)
        await bot.api.sendMessage(ADMIN_GROUP_ID, errorPrefix + text, { 
            parse_mode: 'HTML', 
            message_thread_id: threadId || undefined
        });
    }
}

async function copyToGroup(ctx) {
    if (!ADMIN_GROUP_ID) return;
    const user = ctx.from;
    
    let result = await getTopicForUser(user);
    let threadId = (typeof result === 'object' && result?.error) ? null : result;

    try {
        if (threadId) {
            await ctx.copyMessage(ADMIN_GROUP_ID, { message_thread_id: threadId });
        } else {
            // Если топик создать не удалось сразу
            await ctx.reply(`⚠️ Ошибка системы тикетов: ${result.error}`);
            await ctx.copyMessage(ADMIN_GROUP_ID); // Шлем в General
        }
    } catch (e) {
        // Ошибка пересылки (топик удален)
        await redis.del(`user:${user.id}`);
        if (threadId) await redis.del(`thread:${threadId}`);
        
        result = await createNewTopic(user);
        threadId = (typeof result === 'object' && result?.error) ? null : result;
        
        if (threadId) {
            await ctx.copyMessage(ADMIN_GROUP_ID, { message_thread_id: threadId });
        } else {
            // Фолбэк в General с уведомлением
            await bot.api.sendMessage(ADMIN_GROUP_ID, `⚠️ <b>Сбой топика:</b> ${result?.error || e.message}\nСообщение от ${user.first_name}:`, { parse_mode: 'HTML' });
            await ctx.copyMessage(ADMIN_GROUP_ID);
        }
    }
}

// === ОБРАБОТЧИКИ ===

bot.on('message', async (ctx, next) => {
    if (ctx.message.web_app_data || ctx.message.is_automatic_forward) return next();

    const chatId = ctx.chat.id.toString();
    
    // 1. КЛИЕНТ -> АДМИН
    if (ctx.chat.type === 'private') {
        await copyToGroup(ctx);
    } 
    // 2. АДМИН -> КЛИЕНТ
    else if (chatId === ADMIN_GROUP_ID && ctx.message.message_thread_id) {
        const userId = await redis.get(`thread:${ctx.message.message_thread_id}`);
        if (userId) {
            try {
                await ctx.copyMessage(userId);
            } catch (e) { console.error("Ошибка ответа:", e); }
        }
    }
    return next();
});

// Заказы
bot.on('message:web_app_data', async (ctx) => {
    const { data } = ctx.message.web_app_data;
    const order = JSON.parse(data);
    await sendToGroup(createManagerMessage(order, ctx.from), ctx.from);
    await ctx.reply(createClientMessage(order), { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });
});

const handleUpdate = webhookCallback(bot, 'http');

module.exports = async (req, res) => {
    if (req.method === 'GET') return res.status(200).send('Bot Running');
    if (req.body?.type === 'DIRECT_ORDER') {
        const { order, user } = req.body;
        await sendToGroup(createManagerMessage(order, user), user);
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
    try { return await handleUpdate(req, res); } catch (e) { return res.status(500).send('Error'); }
};

bot.command('start', async (ctx) => {
    if (ctx.chat.type === 'private') await ctx.reply('👋 Конструктор готов! Нажмите кнопку ниже.', { reply_markup: KEYBOARD });
});