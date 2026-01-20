const { Bot, webhookCallback } = require('grammy');
const Redis = require('ioredis'); // Подключаем стандартный Redis

const bot = new Bot(process.env.BOT_TOKEN);
const ADMIN_GROUP_ID = process.env.MANAGER_CHAT_ID; // ID ГРУППЫ (начинается на -100...)
const webAppUrl = process.env.WEBAPP_URL; 

// Подключаемся к твоей базе Redis Labs
// Используем tls: true если сервер требует, но для redislabs часто хватает просто URL
const redis = new Redis(process.env.REDIS_URL); 

// Ловим ошибки базы, чтобы бот не падал
redis.on('error', (err) => console.error('Redis Client Error', err));

const KEYBOARD = {
    keyboard: [[{ text: "✅ Открыть конструктор", web_app: { url: webAppUrl } }]],
    resize_keyboard: true
};

bot.command('start', async (ctx) => {
    if (ctx.chat.type === 'private') {
        await ctx.reply('👋 Конструктор готов! Нажмите кнопку ниже.\n\n💬 Если у вас есть вопросы — пишите прямо сюда, менеджер ответит.', { reply_markup: KEYBOARD });
    }
});

// --- ЛОГИКА РАБОТЫ С ТОПИКАМИ ---

async function getOrCreateTopic(user) {
    const userId = user.id;
    // Ищем в базе
    const existingThreadId = await redis.get(`user:${userId}`);
    
    if (existingThreadId) {
        return parseInt(existingThreadId); // Redis возвращает строку, приводим к числу
    }

    try {
        // Создаем топик
        const topicName = `${user.first_name} ${user.last_name || ''} (@${user.username || 'anon'})`.trim().substring(0, 60);
        const topic = await bot.api.createForumTopic(ADMIN_GROUP_ID, topicName);
        
        // Сохраняем в базу
        await redis.set(`user:${userId}`, topic.message_thread_id);
        await redis.set(`thread:${topic.message_thread_id}`, userId);

        return topic.message_thread_id;
    } catch (e) {
        console.error("Ошибка создания топика:", e);
        return null;
    }
}

// --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ---

function createManagerMessage(orderData, user) {
    let msg = `🆕 <b>НОВЫЙ ЗАКАЗ</b>\n\n`;
    msg += `💰 <b>Итого:</b> ${orderData.total}\n`;
    msg += `📏 <b>Габариты:</b> ${orderData.dims}\n`;
    msg += `⚖️ <b>Вес:</b> ${orderData.weight.replace('Вес:', '')}\n\n`;
    msg += `📋 <b>Состав:</b>\n`;
    orderData.items.forEach((item, i) => {
        msg += `${i + 1}. ${item.name} (${item.color})\n`;
        msg += `   └ ${item.price ? item.price.toLocaleString() + ' ₽' : 'Вкл'}\n`;
    });
    return msg;
}

function createClientMessage(orderData) {
    let msg = `✅ <b>Ваша заявка принята!</b>\n\n`;
    msg += `Менеджер скоро ответит вам в этом чате.\n\n`;
    msg += `📋 <b>Ваш заказ:</b>\n`;
    orderData.items.forEach((item, i) => {
        msg += `${i + 1}. ${item.name} (${item.color})\n`;
    });
    msg += `\n💰 <b>Итого:</b> ${orderData.total}`;
    return msg;
}

async function sendOrderToManager(orderData, userData) {
    const message = createManagerMessage(orderData, userData);
    
    if (ADMIN_GROUP_ID) {
        const threadId = await getOrCreateTopic(userData);
        await bot.api.sendMessage(ADMIN_GROUP_ID, message, { 
            parse_mode: 'HTML',
            message_thread_id: threadId || undefined // Если топик не создался, шлем в общий
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

// --- ОБРАБОТЧИК ЧАТА ---

bot.on('message', async (ctx, next) => {
    if (ctx.message.web_app_data || ctx.message.is_topic_message || ctx.message.is_automatic_forward) {
        return next();
    }

    // КЛИЕНТ -> АДМИН
    if (ctx.chat.type === 'private') {
        const threadId = await getOrCreateTopic(ctx.from);
        if (ADMIN_GROUP_ID && threadId) {
            await ctx.copyMessage(ADMIN_GROUP_ID, { message_thread_id: threadId });
        }
    } 
    // АДМИН -> КЛИЕНТ
    else if (ctx.chat.id.toString() === ADMIN_GROUP_ID && ctx.message.message_thread_id) {
        const userId = await redis.get(`thread:${ctx.message.message_thread_id}`);
        if (userId) {
            try {
                await ctx.copyMessage(userId);
            } catch (e) { console.error("Ошибка отправки клиенту:", e); }
        }
    }
    
    return next();
});

// --- ОБРАБОТЧИК ЗАКАЗОВ ---

bot.on('message:web_app_data', async (ctx) => {
    try {
        const { data } = ctx.message.web_app_data;
        const order = JSON.parse(data);
        const user = ctx.from; 

        await sendOrderToManager(order, user);
        
        await ctx.reply(createClientMessage(order), { 
            parse_mode: 'HTML',
            reply_markup: { remove_keyboard: true } 
        });
    } catch (e) { console.error(e); }
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