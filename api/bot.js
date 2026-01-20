const { Bot, webhookCallback } = require('grammy');
const Redis = require('ioredis');

const bot = new Bot(process.env.BOT_TOKEN);
const ADMIN_GROUP_ID = process.env.MANAGER_CHAT_ID; 
const webAppUrl = process.env.WEBAPP_URL; 

const redis = new Redis(process.env.REDIS_URL); 
redis.on('error', (err) => console.error('Redis Client Error', err));

const KEYBOARD = {
    keyboard: [[{ text: "✅ Открыть конструктор", web_app: { url: webAppUrl } }]],
    resize_keyboard: true
};

// --- ФУНКЦИИ БАЗЫ И СООБЩЕНИЙ ---

async function getOrCreateTopic(user) {
    const userId = user.id;
    const existingThreadId = await redis.get(`user:${userId}`);
    if (existingThreadId) return parseInt(existingThreadId);

    try {
        const topicName = `${user.first_name} ${user.last_name || ''} (@${user.username || 'anon'})`.trim().substring(0, 60);
        const topic = await bot.api.createForumTopic(ADMIN_GROUP_ID, topicName);
        
        await redis.set(`user:${userId}`, topic.message_thread_id);
        await redis.set(`thread:${topic.message_thread_id}`, userId);

        return topic.message_thread_id;
    } catch (e) {
        console.error("Ошибка создания топика:", e);
        return null;
    }
}

function createManagerMessage(orderData, user) {
    let msg = `🆕 <b>НОВЫЙ ЗАКАЗ</b>\n\n`;
    const username = user.username ? `@${user.username}` : 'Без ника';
    msg += `👤 <b>Клиент:</b> ${username} (ID: ${user.id})\n\n`;
    msg += `📋 <b>Состав заказа:</b>\n`;
    orderData.items.forEach((item, i) => {
        msg += `${i + 1}. ${item.name} (${item.color})\n`;
        msg += `   └ ${item.price ? item.price.toLocaleString() + ' ₽' : 'Вкл'}\n`;
    });
    msg += `\n💰 <b>Итого:</b> ${orderData.total}\n`;
    msg += `📏 <b>Габариты:</b> ${orderData.dims}\n`;
    msg += `⚖️ ${orderData.weight.replace('Вес:', '<b>Вес:</b>')}`;
    return msg;
}

function createClientMessage(orderData) {
    let msg = `✅ <b>Ваша заявка принята!</b>\n\n`;
    msg += `Менеджер свяжется с вами в ближайшее время.\n\n`;
    msg += `📋 <b>Ваш заказ:</b>\n`;
    orderData.items.forEach((item, i) => {
        msg += `${i + 1}. ${item.name} (${item.color})\n`;
        msg += `   └ ${item.price ? item.price.toLocaleString() + ' ₽' : 'Вкл'}\n`;
    });
    msg += `\n💰 <b>Итого:</b> ${orderData.total}\n`;
    msg += `📏 <b>Габариты:</b> ${orderData.dims}\n`;
    msg += `⚖️ ${orderData.weight.replace('Вес:', '<b>Вес:</b>')}`;
    return msg;
}

// --- ОТПРАВКА ---

async function sendOrderToManager(orderData, userData) {
    const message = createManagerMessage(orderData, userData);
    if (ADMIN_GROUP_ID) {
        const threadId = await getOrCreateTopic(userData);
        await bot.api.sendMessage(ADMIN_GROUP_ID, message, { 
            parse_mode: 'HTML',
            message_thread_id: threadId || undefined 
        });
    }
}

async function sendConfirmationToClient(orderData, userData) {
    if (!userData || !userData.id) return;
    try {
        await bot.api.sendMessage(userData.id, createClientMessage(orderData), { 
            parse_mode: 'HTML',
            reply_markup: { remove_keyboard: true } 
        });
    } catch (e) { console.error(e); }
}

// === ГЛАВНЫЙ ОБРАБОТЧИК СООБЩЕНИЙ ===

bot.on('message', async (ctx, next) => {
    // Игнорируем служебные обновления
    if (ctx.message.web_app_data || ctx.message.is_automatic_forward) return next();

    const msg = ctx.message;
    const chatId = ctx.chat.id.toString();
    const adminGroupId = ADMIN_GROUP_ID.toString();

    // 1. КЛИЕНТ -> ПИШЕТ БОТУ В ЛИЧКУ
    if (ctx.chat.type === 'private') {
        const threadId = await getOrCreateTopic(ctx.from);
        if (ADMIN_GROUP_ID && threadId) {
            try {
                await ctx.copyMessage(ADMIN_GROUP_ID, { message_thread_id: threadId });
            } catch (e) { console.error("Ошибка пересылки админу:", e); }
        }
    } 
    
    // 2. АДМИН -> ПИШЕТ В ГРУППЕ (Топике)
    // Проверяем, что ID чата совпадает с ID группы админов
    else if (chatId === adminGroupId) {
        
        // ЛОГ ДЛЯ ОТЛАДКИ (Смотреть в Vercel Logs)
        console.log(`💬 Сообщение в группе. ThreadID: ${msg.message_thread_id}`);

        if (msg.message_thread_id) {
            // Ищем владельца топика
            const userId = await redis.get(`thread:${msg.message_thread_id}`);
            
            if (userId) {
                try {
                    // Пересылаем копию клиенту
                    await ctx.copyMessage(userId);
                    console.log(`✅ Переслано пользователю ${userId}`);
                } catch (e) {
                    console.error(`❌ Ошибка отправки юзеру ${userId}:`, e.message);
                }
            } else {
                console.log(`⚠️ Не найден UserID для топика ${msg.message_thread_id}. База пуста?`);
            }
        }
    }
    
    return next();
});

// === ОБРАБОТКА ЗАКАЗОВ ===

bot.on('message:web_app_data', async (ctx) => {
    try {
        const { data } = ctx.message.web_app_data;
        const order = JSON.parse(data);
        const user = ctx.from; 
        await sendOrderToManager(order, user);
        await ctx.reply(createClientMessage(order), { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });
    } catch (e) { console.error(e); }
});

bot.command('start', async (ctx) => {
    if (ctx.chat.type === 'private') {
        await ctx.reply('👋 Конструктор готов! Нажмите кнопку ниже.\n\n💬 Пишите сюда — менеджер ответит.', { reply_markup: KEYBOARD });
    }
});

const handleUpdate = webhookCallback(bot, 'http');

module.exports = async (req, res) => {
    if (req.method === 'GET') return res.status(200).send('Bot Running');
    if (req.body && req.body.type === 'DIRECT_ORDER') {
        const { order, user } = req.body;
        await sendOrderToManager(order, user);
        await sendConfirmationToClient(order, user);
        return res.status(200).json({ success: true });
    }
    try {
        return await handleUpdate(req, res);
    } catch (e) {
        return res.status(500).send('Error');
    }
};