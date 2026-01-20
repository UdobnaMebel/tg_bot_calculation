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

// --- ФУНКЦИИ БАЗЫ ДАННЫХ ---

async function getOrCreateTopic(user) {
    const userId = user.id;
    // 1. Ищем существующий топик
    const existingThreadId = await redis.get(`user:${userId}`);
    if (existingThreadId) return parseInt(existingThreadId);

    // 2. Создаем новый, если нет
    try {
        const topicName = `${user.first_name} ${user.last_name || ''} (@${user.username || 'anon'})`.trim().substring(0, 60);
        const topic = await bot.api.createForumTopic(ADMIN_GROUP_ID, topicName);
        
        // Сохраняем зеркальную связь
        await redis.set(`user:${userId}`, topic.message_thread_id);
        await redis.set(`thread:${topic.message_thread_id}`, userId);

        return topic.message_thread_id;
    } catch (e) {
        console.error("Ошибка создания топика:", e);
        return null;
    }
}

// --- ФОРМАТИРОВАНИЕ СООБЩЕНИЙ (Исправлено) ---

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

// --- ОТПРАВКА ЗАКАЗОВ ---

async function sendOrderToManager(orderData, userData) {
    const message = createManagerMessage(orderData, userData);
    if (ADMIN_GROUP_ID) {
        // Создаем топик или получаем существующий
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
    // Игнорируем только системные пересылки и данные заказа
    // ВАЖНО: Убрали фильтр is_topic_message, чтобы админ мог писать!
    if (ctx.message.web_app_data || ctx.message.is_automatic_forward) {
        return next();
    }

    const msg = ctx.message;

    // 1. КЛИЕНТ ПИШЕТ БОТУ (В личку)
    if (ctx.chat.type === 'private') {
        const threadId = await getOrCreateTopic(ctx.from);
        
        if (ADMIN_GROUP_ID && threadId) {
            try {
                // Копируем сообщение в топик клиента
                await ctx.copyMessage(ADMIN_GROUP_ID, { message_thread_id: threadId });
            } catch (e) {
                console.error("Ошибка пересылки в группу:", e);
            }
        }
    } 
    
    // 2. АДМИН ПИШЕТ В ТОПИКЕ (ID чата совпадает с ID группы)
    else if (ctx.chat.id.toString() === ADMIN_GROUP_ID.toString()) {
        
        // Проверяем, что это сообщение внутри топика (есть thread_id)
        if (msg.message_thread_id) {
            // Ищем в базе: чей это топик?
            const userId = await redis.get(`thread:${msg.message_thread_id}`);
            
            if (userId) {
                try {
                    // Копируем сообщение клиенту
                    await ctx.copyMessage(userId);
                } catch (e) {
                    console.error("Не удалось отправить клиенту (блок?):", e);
                }
            } else {
                console.log("⚠️ ID пользователя для этого топика не найден в базе.");
            }
        }
    }
    
    return next();
});

// === ОБРАБОТКА ЗАКАЗОВ (Стандартный путь) ===
bot.on('message:web_app_data', async (ctx) => {
    try {
        const { data } = ctx.message.web_app_data;
        const order = JSON.parse(data);
        const user = ctx.from; 

        await sendOrderToManager(order, user);
        
        // Ответ клиенту с удалением кнопки
        await ctx.reply(createClientMessage(order), { 
            parse_mode: 'HTML', 
            reply_markup: { remove_keyboard: true } 
        });
    } catch (e) { console.error(e); }
});

// Команда /start
bot.command('start', async (ctx) => {
    if (ctx.chat.type === 'private') {
        await ctx.reply('👋 Конструктор готов! Нажмите кнопку ниже.\n\n💬 Пишите сюда — менеджер ответит.', { reply_markup: KEYBOARD });
    }
});

// Прямой fetch (для меню)
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