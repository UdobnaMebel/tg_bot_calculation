const { Bot, webhookCallback } = require('grammy');
const Redis = require('ioredis');

const bot = new Bot(process.env.BOT_TOKEN);
// Очищаем ID от кавычек и пробелов (на всякий случай)
const ADMIN_GROUP_ID = (process.env.MANAGER_CHAT_ID || '').trim().replace(/['"]/g, ''); 
const webAppUrl = process.env.WEBAPP_URL; 

// Подключение к Redis
const redis = new Redis(process.env.REDIS_URL); 
redis.on('error', (err) => console.error('Redis Client Error', err));

const KEYBOARD = {
    keyboard: [[{ text: "✅ Открыть конструктор", web_app: { url: webAppUrl } }]],
    resize_keyboard: true
};

// --- ФУНКЦИИ БАЗЫ ДАННЫХ ---

// Создание НОВОГО топика
async function createNewTopic(user) {
    try {
        const topicName = `${user.first_name} ${user.last_name || ''} (@${user.username || 'anon'})`.trim().substring(0, 60);
        const topic = await bot.api.createForumTopic(ADMIN_GROUP_ID, topicName);
        
        // Сохраняем связи: Юзер <-> Топик
        await redis.set(`user:${user.id}`, topic.message_thread_id);
        await redis.set(`thread:${topic.message_thread_id}`, user.id);
        
        return topic.message_thread_id;
    } catch (e) {
        console.error("🔴 Ошибка создания топика:", e.message);
        return null; // Если бот не админ или группа не супергруппа
    }
}

// Получить ID топика (или создать, если нет)
async function getTopicForUser(user) {
    const existingThreadId = await redis.get(`user:${user.id}`);
    if (existingThreadId) return parseInt(existingThreadId);
    return await createNewTopic(user);
}

// --- ФОРМАТИРОВАНИЕ СООБЩЕНИЙ ---

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
        // Пытаемся получить топик
        let threadId = await getTopicForUser(userData);
        
        try {
            await bot.api.sendMessage(ADMIN_GROUP_ID, message, { 
                parse_mode: 'HTML',
                message_thread_id: threadId || undefined 
            });
        } catch (e) {
            // Если топик был удален руками, создаем новый и пробуем снова
            console.log("Топик не найден, создаем новый...");
            await redis.del(`user:${userData.id}`);
            threadId = await createNewTopic(userData);
            
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

// === ЧАТ-БОТ (ПЕРЕПИСКА) ===

bot.on('message', async (ctx, next) => {
    // Пропускаем служебные
    if (ctx.message.web_app_data || ctx.message.is_automatic_forward) return next();

    const msg = ctx.message;
    const currentChatId = ctx.chat.id.toString();
    
    // 1. КЛИЕНТ ПИШЕТ БОТУ (В ЛИЧКУ)
    if (ctx.chat.type === 'private') {
        let threadId = await getTopicForUser(ctx.from);
        
        if (ADMIN_GROUP_ID) {
            try {
                // Копируем сообщение в топик
                await ctx.copyMessage(ADMIN_GROUP_ID, { message_thread_id: threadId });
            } catch (e) {
                // Если топик удален - создаем новый и шлем туда
                await redis.del(`user:${ctx.from.id}`);
                threadId = await createNewTopic(ctx.from);
                if (threadId) {
                    await ctx.copyMessage(ADMIN_GROUP_ID, { message_thread_id: threadId });
                }
            }
        }
    } 
    
    // 2. АДМИН ПИШЕТ В ГРУППЕ (В ТОПИКЕ)
    else if (currentChatId === ADMIN_GROUP_ID) {
        // Проверяем, что это сообщение внутри топика
        if (msg.message_thread_id) {
            const userId = await redis.get(`thread:${msg.message_thread_id}`);
            
            if (userId) {
                try {
                    // Копируем ответ клиенту
                    await ctx.copyMessage(userId);
                } catch (e) {
                    console.error(`Не удалось отправить пользователю ${userId}:`, e.message);
                }
            }
        }
    }
    
    return next();
});

// === ОБРАБОТЧИКИ ЗАКАЗОВ ===

// 1. WebApp Data (Кнопка внизу)
bot.on('message:web_app_data', async (ctx) => {
    try {
        const { data } = ctx.message.web_app_data;
        const order = JSON.parse(data);
        const user = ctx.from; 

        await sendOrderToManager(order, user);
        
        // Ответ клиенту (удаляем кнопку)
        await ctx.reply(createClientMessage(order), { 
            parse_mode: 'HTML', 
            reply_markup: { remove_keyboard: true } 
        });
    } catch (e) { console.error(e); }
});

// 2. Команда /start
bot.command('start', async (ctx) => {
    if (ctx.chat.type === 'private') {
        await ctx.reply('👋 Конструктор готов! Нажмите кнопку ниже.\n\n💬 Пишите сюда — менеджер ответит.', { reply_markup: KEYBOARD });
    }
});

// 3. Direct Fetch (Кнопка меню)
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