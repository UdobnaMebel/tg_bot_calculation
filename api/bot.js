const { Bot, webhookCallback } = require('grammy');
const Redis = require('ioredis');

const bot = new Bot(process.env.BOT_TOKEN);
const ADMIN_GROUP_ID = process.env.MANAGER_CHAT_ID; 
const webAppUrl = process.env.WEBAPP_URL; 

// Подключение к Redis
const redis = new Redis(process.env.REDIS_URL); 
redis.on('error', (err) => console.error('Redis Client Error', err));

const KEYBOARD = {
    keyboard: [[{ text: "✅ Открыть конструктор", web_app: { url: webAppUrl } }]],
    resize_keyboard: true
};

// --- ФУНКЦИИ ---

async function getOrCreateTopic(user) {
    const userId = user.id;
    // 1. Проверяем, есть ли уже топик
    const existingThreadId = await redis.get(`user:${userId}`);
    if (existingThreadId) return parseInt(existingThreadId);

    // 2. Если нет — создаем
    try {
        const topicName = `${user.first_name} ${user.last_name || ''} (@${user.username || 'anon'})`.trim().substring(0, 60);
        const topic = await bot.api.createForumTopic(ADMIN_GROUP_ID, topicName);
        
        // Сохраняем связи: Юзер <-> Топик
        await redis.set(`user:${userId}`, topic.message_thread_id);
        await redis.set(`thread:${topic.message_thread_id}`, userId);

        return topic.message_thread_id;
    } catch (e) {
        console.error("Ошибка создания топика:", e);
        return null;
    }
}

// ... (Функции формирования сообщений оставляем те же, я их сократил для удобства чтения) ...
function createManagerMessage(orderData, user) {
    let msg = `🆕 <b>НОВЫЙ ЗАКАЗ</b>\n\n💰 <b>Итого:</b> ${orderData.total}\n`;
    orderData.items.forEach(i => msg += `${i.name} (${i.color}) - ${i.price}\n`);
    return msg;
}
function createClientMessage(orderData) {
    let msg = `✅ <b>Заявка принята!</b>\n\n`;
    orderData.items.forEach(i => msg += `${i.name} (${i.color})\n`);
    msg += `\n💰 <b>Итого:</b> ${orderData.total}`;
    return msg;
}

// Отправка заказа (создает топик)
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
    // Игнорируем служебные сообщения и WebApp данные (они обработаются своим handler'ом)
    if (ctx.message.web_app_data || ctx.message.is_topic_message || ctx.message.is_automatic_forward) {
        return next();
    }

    const msg = ctx.message;

    // СЦЕНАРИЙ 1: Клиент пишет боту в личку
    if (ctx.chat.type === 'private') {
        console.log(`📩 Сообщение от клиента: ${ctx.from.first_name}`);
        
        const threadId = await getOrCreateTopic(ctx.from);
        
        if (ADMIN_GROUP_ID && threadId) {
            try {
                // Копируем сообщение в топик
                await ctx.copyMessage(ADMIN_GROUP_ID, { message_thread_id: threadId });
            } catch (e) {
                console.error("Ошибка пересылки в группу:", e);
            }
        } else {
            // Если топик создать не удалось (например, бот не админ), шлем просто в группу
            await ctx.copyMessage(ADMIN_GROUP_ID); 
        }
    } 
    
    // СЦЕНАРИЙ 2: Админ пишет в Топике (ID чата совпадает с ID группы)
    else if (ctx.chat.id.toString() === ADMIN_GROUP_ID.toString()) {
        console.log(`👨‍💻 Админ пишет в группе. Thread ID: ${msg.message_thread_id}`);

        // Если это сообщение внутри топика (есть thread_id)
        if (msg.message_thread_id) {
            // Ищем, какому юзеру принадлежит этот топик
            const userId = await redis.get(`thread:${msg.message_thread_id}`);
            
            if (userId) {
                try {
                    // Копируем ответ админа клиенту
                    await ctx.copyMessage(userId);
                } catch (e) {
                    console.error("Не удалось отправить клиенту (блок?):", e);
                }
            } else {
                console.log("⚠️ Не найден User ID для этого топика в базе.");
            }
        }
    }
    
    return next();
});

// === ОБРАБОТКА ЗАКАЗОВ ===

// 1. Стандартный sendData
bot.on('message:web_app_data', async (ctx) => {
    try {
        const { data } = ctx.message.web_app_data;
        const order = JSON.parse(data);
        const user = ctx.from; 

        await sendOrderToManager(order, user);
        await ctx.reply(createClientMessage(order), { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });
    } catch (e) { console.error(e); }
});

// 2. Команда /start
bot.command('start', async (ctx) => {
    if (ctx.chat.type === 'private') {
        await ctx.reply('👋 Конструктор готов! Нажмите кнопку ниже.\n\n💬 Пишите сюда — менеджер ответит.', { reply_markup: KEYBOARD });
    }
});

// 3. Прямой fetch
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