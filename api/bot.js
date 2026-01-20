const { Bot, webhookCallback } = require('grammy');
const Redis = require('ioredis');

const bot = new Bot(process.env.BOT_TOKEN);
// Чистим ID от пробелов и кавычек на всякий случай
const ADMIN_GROUP_ID = (process.env.MANAGER_CHAT_ID || '').trim().replace(/['"]/g, ''); 
const webAppUrl = process.env.WEBAPP_URL; 

const redis = new Redis(process.env.REDIS_URL); 
redis.on('error', (err) => console.error('Redis Client Error', err));

const KEYBOARD = {
    keyboard: [[{ text: "✅ Открыть конструктор", web_app: { url: webAppUrl } }]],
    resize_keyboard: true
};

// --- ФУНКЦИИ ---

async function getOrCreateTopic(user) {
    const userId = user.id;
    const existingThreadId = await redis.get(`user:${userId}`);
    if (existingThreadId) return parseInt(existingThreadId);

    try {
        const topicName = `${user.first_name} ${user.last_name || ''} (@${user.username || 'anon'})`.trim().substring(0, 60);
        console.log(`🛠 Создаю топик для ${userId}: ${topicName}`);
        
        const topic = await bot.api.createForumTopic(ADMIN_GROUP_ID, topicName);
        
        await redis.set(`user:${userId}`, topic.message_thread_id);
        await redis.set(`thread:${topic.message_thread_id}`, userId);
        
        console.log(`✅ Топик создан: ${topic.message_thread_id}`);
        return topic.message_thread_id;
    } catch (e) {
        console.error("🔴 Ошибка создания топика:", e.message);
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

// === ЛОГИКА ЧАТА (САППОРТ) ===

bot.on('message', async (ctx, next) => {
    // Игнорируем служебные
    if (ctx.message.web_app_data || ctx.message.is_automatic_forward) return next();

    const currentChatId = ctx.chat.id.toString();
    const threadId = ctx.message.message_thread_id;

    // --- ЛОГИРОВАНИЕ ДЛЯ ОТЛАДКИ ---
    // Если сообщение из группы - пишем в лог
    if (currentChatId === ADMIN_GROUP_ID) {
        console.log(`📢 СООБЩЕНИЕ В ГРУППЕ! Thread: ${threadId}, Text: ${ctx.message.text}`);
    }
    // -------------------------------

    // 1. КЛИЕНТ ПИШЕТ БОТУ (В ЛИЧКУ)
    if (ctx.chat.type === 'private') {
        const topicId = await getOrCreateTopic(ctx.from);
        if (ADMIN_GROUP_ID && topicId) {
            try {
                await ctx.copyMessage(ADMIN_GROUP_ID, { message_thread_id: topicId });
            } catch (e) { console.error("Ошибка пересылки админу:", e); }
        }
    } 
    
    // 2. АДМИН ПИШЕТ В ГРУППЕ (В ТОПИКЕ)
    else if (currentChatId === ADMIN_GROUP_ID) {
        
        if (threadId) {
            // Ищем пользователя в базе
            const userId = await redis.get(`thread:${threadId}`);
            console.log(`🔎 Ищу юзера для топика ${threadId}... Нашел: ${userId}`);

            if (userId) {
                try {
                    await ctx.copyMessage(userId);
                    console.log("✅ Успешно переслано клиенту");
                } catch (e) {
                    console.error(`❌ Ошибка отправки клиенту: ${e.message}`);
                }
            } else {
                console.log("⚠️ Юзер не найден. Возможно, это старый топик?");
            }
        } else {
            console.log("ℹ️ Сообщение в General (без топика), игнорируем.");
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