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

// --- ФУНКЦИИ ---

// Создать новый топик
async function createNewTopic(user) {
    try {
        const dateStr = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        const nameClean = `${user.first_name} ${user.last_name||''}`.trim().substring(0, 30);
        // Добавляем время, чтобы имя было уникальным (избегаем ошибок Telegram)
        const topicName = `${nameClean} [${dateStr}]`;

        const topic = await bot.api.createForumTopic(ADMIN_GROUP_ID, topicName);
        
        await redis.set(`user:${user.id}`, topic.message_thread_id);
        await redis.set(`thread:${topic.message_thread_id}`, user.id);
        
        return topic.message_thread_id;
    } catch (e) {
        // Если ошибка - возвращаем объект с текстом ошибки
        return { error: e.message };
    }
}

// Получить ID топика
async function getTopicForUser(user) {
    const cachedId = await redis.get(`user:${user.id}`);
    if (cachedId) return parseInt(cachedId);
    return await createNewTopic(user);
}

// --- ОТПРАВКА С ИСПРАВЛЕННОЙ ЛОГИКОЙ ---

async function sendToGroupWithRetry(text, user) {
    if (!ADMIN_GROUP_ID) return;

    // 1. Получаем ID (из базы или создаем новый)
    let threadResult = await getTopicForUser(user);
    
    // Если threadResult - это объект с ошибкой (не удалось создать)
    if (typeof threadResult === 'object' && threadResult.error) {
        // Шлем в General с ошибкой
        return await bot.api.sendMessage(ADMIN_GROUP_ID, 
            `⚠️ <b>Не удалось создать топик:</b> ${threadResult.error}\n\n${text}`, 
            { parse_mode: 'HTML' }
        );
    }

    let threadId = threadResult;

    try {
        // 2. Пробуем отправить в полученный ID
        await bot.api.sendMessage(ADMIN_GROUP_ID, text, { 
            parse_mode: 'HTML', 
            message_thread_id: threadId 
        });
    } catch (e) {
        // 3. ОШИБКА ОТПРАВКИ (Например, топик удален)
        // Пишем диагностику в General, чтобы ты видел
        await bot.api.sendMessage(ADMIN_GROUP_ID, `♻️ Топик #${threadId} не найден. Пересоздаю для ${user.first_name}...`);

        // Чистим старую запись
        await redis.del(`user:${user.id}`);
        if (threadId) await redis.del(`thread:${threadId}`);

        // Создаем новый топик
        const newTopicResult = await createNewTopic(user);

        if (typeof newTopicResult === 'object' && newTopicResult.error) {
             await bot.api.sendMessage(ADMIN_GROUP_ID, `❌ Ошибка пересоздания: ${newTopicResult.error}\n\n${text}`, { parse_mode: 'HTML' });
        } else {
             // Отправляем в новый топик
             await bot.api.sendMessage(ADMIN_GROUP_ID, text, { 
                parse_mode: 'HTML', 
                message_thread_id: newTopicResult 
            });
        }
    }
}

// Копирование (для чата) - та же логика
async function copyToGroupWithRetry(ctx) {
    if (!ADMIN_GROUP_ID) return;
    const user = ctx.from;

    let threadResult = await getTopicForUser(user);
    
    // Если ошибка создания
    if (typeof threadResult === 'object' && threadResult.error) {
        await ctx.reply(`Ошибка чата: ${threadResult.error}`);
        return await ctx.copyMessage(ADMIN_GROUP_ID); // В General
    }

    let threadId = threadResult;

    try {
        await ctx.copyMessage(ADMIN_GROUP_ID, { message_thread_id: threadId });
    } catch (e) {
        // Если ошибка копирования
        await redis.del(`user:${user.id}`);
        const newTopic = await createNewTopic(user);
        
        if (typeof newTopic === 'object' && newTopic.error) {
            await ctx.copyMessage(ADMIN_GROUP_ID); // В General
        } else {
            await ctx.copyMessage(ADMIN_GROUP_ID, { message_thread_id: newTopic });
        }
    }
}

// --- СООБЩЕНИЯ ---

function createManagerMessage(order, user) {
    let msg = `🆕 <b>НОВЫЙ ЗАКАЗ</b>\n\n👤 <b>Клиент:</b> @${user.username||'нет'} (ID: ${user.id})\n\n📋 <b>Состав:</b>\n`;
    order.items.forEach(i => msg += `${i.name} (${i.color})\n   └ ${i.price ? i.price.toLocaleString() + ' ₽' : 'Вкл'}\n`);
    msg += `\n💰 <b>Итого:</b> ${order.total}\n📏 ${order.dims}\n⚖️ ${order.weight.replace('Вес:', '<b>Вес:</b>')}`;
    return msg;
}

function createClientMessage(order) {
    let msg = `✅ <b>Ваша заявка принята!</b>\nМенеджер скоро свяжется с вами.\n\n📋 <b>Заказ:</b>\n`;
    order.items.forEach(i => msg += `${i.name} (${i.color})\n`);
    msg += `\n💰 <b>Итого:</b> ${order.total}`;
    return msg;
}

// === ОБРАБОТЧИКИ ===

// 1. ЧАТ (Сообщения)
bot.on('message', async (ctx, next) => {
    if (ctx.message.web_app_data || ctx.message.is_automatic_forward) return next();

    const chatId = ctx.chat.id.toString();
    
    // Клиент -> Админ
    if (ctx.chat.type === 'private') {
        await copyToGroupWithRetry(ctx);
    } 
    // Админ -> Клиент
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

// 2. ЗАКАЗ (WebApp Data)
bot.on('message:web_app_data', async (ctx) => {
    try {
        const { data } = ctx.message.web_app_data;
        const order = JSON.parse(data);
        const user = ctx.from; 
        
        await sendToGroupWithRetry(createManagerMessage(order, user), user);
        
        await ctx.reply(createClientMessage(order), { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });
    } catch (e) { console.error(e); }
});

const handleUpdate = webhookCallback(bot, 'http');

// 3. ПРЯМОЙ ЗАКАЗ (Fetch)
module.exports = async (req, res) => {
    if (req.method === 'GET') return res.status(200).send('Bot Running');
    
    if (req.body?.type === 'DIRECT_ORDER') {
        const { order, user } = req.body;
        await sendToGroupWithRetry(createManagerMessage(order, user), user);
        
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