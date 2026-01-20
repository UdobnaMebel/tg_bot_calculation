const { Bot, webhookCallback } = require('grammy');
const Redis = require('ioredis');

const bot = new Bot(process.env.BOT_TOKEN);
// Чистим ID от лишних пробелов и кавычек
const ADMIN_GROUP_ID = (process.env.MANAGER_CHAT_ID || '').trim().replace(/['"]/g, ''); 
const webAppUrl = process.env.WEBAPP_URL; 

// Подключаемся к Redis
const redis = new Redis(process.env.REDIS_URL); 
redis.on('error', (err) => console.error('Redis Client Error', err));

const KEYBOARD = {
    keyboard: [[{ text: "✅ Открыть конструктор", web_app: { url: webAppUrl } }]],
    resize_keyboard: true
};

// --- ФУНКЦИИ БАЗЫ ДАННЫХ ---

// Функция создания НОВОГО топика (выделена отдельно)
async function createNewTopic(user) {
    try {
        const topicName = `${user.first_name} ${user.last_name || ''} (@${user.username || 'anon'})`.trim().substring(0, 60);
        console.log(`🔨 Создаю новый топик для ${user.id}...`);
        
        const topic = await bot.api.createForumTopic(ADMIN_GROUP_ID, topicName);
        
        // Сохраняем в базу
        await redis.set(`user:${user.id}`, topic.message_thread_id);
        await redis.set(`thread:${topic.message_thread_id}`, user.id);
        
        return topic.message_thread_id;
    } catch (e) {
        console.error("🔴 Ошибка создания топика:", e.message);
        return null;
    }
}

// Получить ID топика (или создать, если нет)
async function getTopicForUser(user) {
    const existingThreadId = await redis.get(`user:${user.id}`);
    if (existingThreadId) return parseInt(existingThreadId);
    return await createNewTopic(user);
}

// --- СООБЩЕНИЯ ---

function createManagerMessage(orderData, user) {
    let msg = `🆕 <b>НОВЫЙ ЗАКАЗ</b>\n\n`;
    const username = user.username ? `@${user.username}` : 'Без ника';
    msg += `👤 <b>Клиент:</b> ${username} (ID: ${user.id})\n\n`;
    msg += `📋 <b>Состав заказа:</b>\n`;
    orderData.items.forEach(i => msg += `${i.name} (${i.color})\n   └ ${i.price ? i.price.toLocaleString() + ' ₽' : 'Вкл'}\n`);
    msg += `\n💰 <b>Итого:</b> ${orderData.total}\n📏 <b>Габариты:</b> ${orderData.dims}\n⚖️ ${orderData.weight.replace('Вес:', '<b>Вес:</b>')}`;
    return msg;
}

function createClientMessage(orderData) {
    let msg = `✅ <b>Ваша заявка принята!</b>\n\nМенеджер свяжется с вами в ближайшее время.\n\n📋 <b>Ваш заказ:</b>\n`;
    orderData.items.forEach(i => msg += `${i.name} (${i.color})\n   └ ${i.price ? i.price.toLocaleString() + ' ₽' : 'Вкл'}\n`);
    msg += `\n💰 <b>Итого:</b> ${orderData.total}\n📏 <b>Габариты:</b> ${orderData.dims}\n⚖️ ${orderData.weight.replace('Вес:', '<b>Вес:</b>')}`;
    return msg;
}

// --- ОТПРАВКА (САМОИСЦЕЛЯЮЩАЯСЯ) ---

async function sendOrderToManager(orderData, userData) {
    const message = createManagerMessage(orderData, userData);
    
    if (ADMIN_GROUP_ID) {
        let threadId = await getTopicForUser(userData);
        
        try {
            await bot.api.sendMessage(ADMIN_GROUP_ID, message, { 
                parse_mode: 'HTML',
                message_thread_id: threadId || undefined 
            });
        } catch (e) {
            console.log("⚠️ Ошибка отправки в топик (удален?). Создаем новый...");
            // Если ошибка - удаляем старую запись и создаем новый топик
            await redis.del(`user:${userData.id}`);
            threadId = await createNewTopic(userData);
            
            // Пробуем снова в новый топик
            if (threadId) {
                await bot.api.sendMessage(ADMIN_GROUP_ID, message, { 
                    parse_mode: 'HTML',
                    message_thread_id: threadId 
                });
            }
        }
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

// === ГЛАВНЫЙ ОБРАБОТЧИК ===

bot.on('message', async (ctx, next) => {
    if (ctx.message.web_app_data || ctx.message.is_automatic_forward) return next();

    const msg = ctx.message;
    const chatId = ctx.chat.id.toString(); // ID чата, откуда пришло
    const adminIdString = ADMIN_GROUP_ID.toString(); // ID группы админов

    // 1. КЛИЕНТ ПИШЕТ БОТУ
    if (ctx.chat.type === 'private') {
        let threadId = await getTopicForUser(ctx.from);
        
        if (ADMIN_GROUP_ID) {
            try {
                // Пытаемся переслать в топик
                await ctx.copyMessage(ADMIN_GROUP_ID, { message_thread_id: threadId });
            } catch (e) {
                console.log("⚠️ Топик не найден при пересылке. Создаем новый...");
                // Если не вышло (топик удален) - чистим базу и создаем новый
                await redis.del(`user:${ctx.from.id}`);
                threadId = await createNewTopic(ctx.from);
                if (threadId) {
                    await ctx.copyMessage(ADMIN_GROUP_ID, { message_thread_id: threadId });
                }
            }
        }
    } 
    
    // 2. АДМИН ПИШЕТ В ГРУППЕ
    else if (chatId === adminIdString) {
        // Лог для отладки
        console.log(`📢 Сообщение в группе. ThreadID: ${msg.message_thread_id}`);

        if (msg.message_thread_id) {
            const userId = await redis.get(`thread:${msg.message_thread_id}`);
            console.log(`🔎 UserID для этого топика: ${userId}`);
            
            if (userId) {
                try {
                    await ctx.copyMessage(userId);
                    console.log("✅ Ответ отправлен клиенту");
                } catch (e) {
                    console.error("❌ Клиент заблокировал бота или ошибка:", e.message);
                }
            }
        }
    }
    
    return next();
});

// === ОБРАБОТЧИКИ ЗАКАЗОВ ===

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