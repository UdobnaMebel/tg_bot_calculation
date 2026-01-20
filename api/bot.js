const { Bot, webhookCallback } = require('grammy');
const { kv } = require('@vercel/kv');

const bot = new Bot(process.env.BOT_TOKEN);
const ADMIN_GROUP_ID = (process.env.MANAGER_CHAT_ID || '').trim().replace(/['"]/g, ''); 
const webAppUrl = process.env.WEBAPP_URL; 

const KEYBOARD = {
    keyboard: [[{ text: "✅ Открыть конструктор", web_app: { url: webAppUrl } }]],
    resize_keyboard: true
};

// --- 1. ФУНКЦИИ БАЗЫ (ТОПИКИ) ---

async function createNewTopic(user) {
    try {
        const randomId = Math.floor(Math.random() * 1000);
        const nameClean = `${user.first_name} ${user.last_name||''}`.trim().substring(0, 30);
        const topicName = `${nameClean} #${randomId}`;

        const topic = await bot.api.createForumTopic(ADMIN_GROUP_ID, topicName);
        
        // ВАЖНО: Записываем связь в ОБЕ стороны
        await kv.set(`user:${user.id}`, topic.message_thread_id);
        await kv.set(`thread:${topic.message_thread_id}`, user.id);
        
        return topic.message_thread_id;
    } catch (e) {
        console.error("Create Topic Error:", e.message);
        return null; // Если не вышло (например, лимиты)
    }
}

// Получить ID (только чтение из базы)
async function getCachedTopicId(userId) {
    const cachedId = await kv.get(`user:${userId}`);
    if (cachedId && !isNaN(parseInt(cachedId))) return parseInt(cachedId);
    return null;
}

// --- 2. УМНАЯ ОТПРАВКА (С РЕАНИМАЦИЕЙ) ---

// Функция отправки ТЕКСТА (для заказов и уведомлений)
async function sendToAdminSmart(text, user) {
    if (!ADMIN_GROUP_ID) return;

    // 1. Пробуем получить старый ID
    let threadId = await getCachedTopicId(user.id);

    // Если топика нет в базе, создаем сразу
    if (!threadId) {
        threadId = await createNewTopic(user);
    }

    try {
        // 2. Пытаемся отправить
        // Если threadId все еще null (не удалось создать), уйдет в General
        await bot.api.sendMessage(ADMIN_GROUP_ID, text, { 
            parse_mode: 'HTML', 
            message_thread_id: threadId || undefined 
        });
    } catch (e) {
        // 3. ЕСЛИ ОШИБКА (например, TOPIC_DELETED)
        console.error(`Ошибка отправки в ${threadId}: ${e.message}`);
        
        // Удаляем старые данные
        await kv.del(`user:${user.id}`);
        if (threadId) await kv.del(`thread:${threadId}`); // Чистим обратную связь тоже!

        // Создаем новый топик
        const newThreadId = await createNewTopic(user);
        
        // Пробуем отправить снова в новый топик
        try {
            await bot.api.sendMessage(ADMIN_GROUP_ID, text, { 
                parse_mode: 'HTML', 
                message_thread_id: newThreadId || undefined 
            });
        } catch (e2) {
            // Если совсем всё плохо - шлем в General с ошибкой
            await bot.api.sendMessage(ADMIN_GROUP_ID, `🔥 <b>Критический сбой:</b> ${e.message}\n\n${text}`, { parse_mode: 'HTML' });
        }
    }
}

// Функция ПЕРЕСЫЛКИ (для сообщений клиента)
async function copyToAdminSmart(ctx) {
    if (!ADMIN_GROUP_ID) return;
    const user = ctx.from;

    let threadId = await getCachedTopicId(user.id);
    if (!threadId) threadId = await createNewTopic(user);

    try {
        await ctx.copyMessage(ADMIN_GROUP_ID, { message_thread_id: threadId || undefined });
    } catch (e) {
        // Ошибка - топик мертв
        await kv.del(`user:${user.id}`);
        if (threadId) await kv.del(`thread:${threadId}`);

        const newThreadId = await createNewTopic(user);
        
        try {
            await ctx.copyMessage(ADMIN_GROUP_ID, { message_thread_id: newThreadId || undefined });
        } catch (e2) {
            await ctx.copyMessage(ADMIN_GROUP_ID); // В General
        }
    }
}

// --- 3. ГЕНЕРАЦИЯ СООБЩЕНИЙ ---

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

// ==========================================
// 4. ОБРАБОТЧИКИ (СТРОГИЙ ПОРЯДОК)
// ==========================================

// А) Команда START
bot.command('start', async (ctx) => {
    if (ctx.chat.type === 'private') {
        await ctx.reply('👋 Конструктор готов! Нажмите кнопку ниже.\n\n💬 Пишите сюда — менеджер ответит.', { reply_markup: KEYBOARD });
        // Уведомляем админа, чтобы создался топик
        await sendToAdminSmart(`👋 Пользователь нажал <b>/start</b>`, ctx.from);
    }
});

// Б) Заказ (WebApp Data)
bot.on('message:web_app_data', async (ctx) => {
    try {
        const order = JSON.parse(ctx.message.web_app_data.data);
        // Шлем админу (с авто-созданием топика)
        await sendToAdminSmart(createManagerMessage(order, ctx.from), ctx.from);
        // Шлем клиенту
        await ctx.reply(createClientMessage(order), { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });
    } catch (e) { console.error(e); }
});

// В) Переписка (Клиент <-> Админ)
bot.on('message', async (ctx, next) => {
    // Игнорируем служебные
    if (ctx.message.is_topic_message || ctx.message.is_automatic_forward) return next();

    const chatId = ctx.chat.id.toString();
    
    // 1. Клиент пишет боту
    if (ctx.chat.type === 'private') {
        await copyToAdminSmart(ctx);
    } 
    // 2. Админ пишет в Группе (в Топике)
    else if (chatId === ADMIN_GROUP_ID) {
        const threadId = ctx.message.message_thread_id;
        
        if (threadId) {
            // Ищем юзера по ID топика
            const userId = await kv.get(`thread:${threadId}`);
            
            if (userId) {
                try {
                    await ctx.copyMessage(userId);
                } catch (e) { 
                    console.error(`Ошибка ответа юзеру ${userId}:`, e.message);
                    // Можно поставить реакцию 👎, если не ушло
                }
            } else {
                console.log(`[DEBUG] Не найден юзер для топика ${threadId}`);
            }
        }
    }
});

// ЗАПУСК
const handleUpdate = webhookCallback(bot, 'http');

module.exports = async (req, res) => {
    if (req.method === 'GET') return res.status(200).send('Bot Running');
    
    if (req.body?.type === 'DIRECT_ORDER') {
        const { order, user } = req.body;
        // Отправка (с авто-созданием топика)
        await sendToAdminSmart(createManagerMessage(order, user), user);
        
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