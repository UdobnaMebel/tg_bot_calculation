const { Bot, webhookCallback } = require('grammy');
const { kv } = require('@vercel/kv');

const bot = new Bot(process.env.BOT_TOKEN);
const ADMIN_GROUP_ID = (process.env.MANAGER_CHAT_ID || '').trim().replace(/['"]/g, ''); 
const webAppUrl = process.env.WEBAPP_URL; 

const KEYBOARD = {
    keyboard: [[{ text: "✅ Открыть конструктор", web_app: { url: webAppUrl } }]],
    resize_keyboard: true
};

// --- БАЗОВЫЕ ФУНКЦИИ ---

// 1. Создание топика
async function createNewTopic(user) {
    try {
        const randomId = Math.floor(Math.random() * 1000);
        const nameClean = `${user.first_name} ${user.last_name||''}`.trim().substring(0, 30);
        const topicName = `${nameClean} #${randomId}`;

        const topic = await bot.api.createForumTopic(ADMIN_GROUP_ID, topicName);
        
        // Сохраняем
        await kv.set(`user:${user.id}`, topic.message_thread_id);
        await kv.set(`thread:${topic.message_thread_id}`, user.id);
        
        return { success: true, id: topic.message_thread_id };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// 2. Получение ID (с проверкой существования)
async function getTopicID(user) {
    // Шаг А: Читаем из базы
    const cachedId = await kv.get(`user:${user.id}`);
    
    if (cachedId) {
        // Шаг Б: Проверяем, жив ли топик в Телеграм (отправляем "печатает...")
        try {
            await bot.api.sendChatAction(ADMIN_GROUP_ID, 'typing', { message_thread_id: cachedId });
            return { success: true, id: cachedId }; // Топик жив
        } catch (e) {
            // Если ошибка "Thread not found" - значит удален
            console.log(`Топик ${cachedId} мертв, удаляем из базы.`);
            await kv.del(`user:${user.id}`);
            if (cachedId) await kv.del(`thread:${cachedId}`);
        }
    }

    // Шаг В: Создаем новый, раз старого нет или он мертв
    return await createNewTopic(user);
}

// --- ОТПРАВКА ---

async function sendToAdmin(text, user) {
    if (!ADMIN_GROUP_ID) return;

    const result = await getTopicID(user);
    
    if (result.success) {
        // Успех - шлем в топик
        try {
            await bot.api.sendMessage(ADMIN_GROUP_ID, text, { parse_mode: 'HTML', message_thread_id: result.id });
        } catch (e) {
            // Если вдруг упало при отправке - шлем в General с логом
            await bot.api.sendMessage(ADMIN_GROUP_ID, `⚠️ <b>Сбой отправки в топик:</b> ${e.message}\n\n${text}`, { parse_mode: 'HTML' });
        }
    } else {
        // Провал создания - шлем в General с причиной
        await bot.api.sendMessage(ADMIN_GROUP_ID, `🛑 <b>Не удалось создать топик:</b> ${result.error}\n\n${text}`, { parse_mode: 'HTML' });
    }
}

async function copyToAdmin(ctx) {
    if (!ADMIN_GROUP_ID) return;
    const user = ctx.from;

    const result = await getTopicID(user);

    if (result.success) {
        try {
            await ctx.copyMessage(ADMIN_GROUP_ID, { message_thread_id: result.id });
        } catch (e) {
            await bot.api.sendMessage(ADMIN_GROUP_ID, `⚠️ <b>Сбой пересылки:</b> ${e.message}`);
            await ctx.copyMessage(ADMIN_GROUP_ID);
        }
    } else {
        await bot.api.sendMessage(ADMIN_GROUP_ID, `🛑 <b>Ошибка топика (${result.error}). Сообщение:</b>`);
        await ctx.copyMessage(ADMIN_GROUP_ID);
    }
}

// --- ГЕНЕРАЦИЯ ТЕКСТОВ ---

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

// ==========================================
// ОБРАБОТЧИКИ
// ==========================================

// 1. КОМАНДА START
bot.command('start', async (ctx) => {
    if (ctx.chat.type === 'private') {
        // Отвечаем клиенту
        await ctx.reply('👋 Конструктор готов! Нажмите кнопку ниже.\n\n💬 Пишите сюда — менеджер ответит.', { reply_markup: KEYBOARD });
        
        // Уведомляем админа в топике (создаем топик, если нет)
        await sendToAdmin(`👋 Пользователь нажал <b>/start</b>`, ctx.from);
    }
});

// 2. РУЧНОЙ СБРОС (На всякий случай)
bot.command('reset', async (ctx) => {
    await kv.del(`user:${ctx.from.id}`);
    await ctx.reply('✅ Данные сброшены.');
});

// 3. ЗАКАЗ (WEBAPP)
bot.on('message:web_app_data', async (ctx) => {
    try {
        const order = JSON.parse(ctx.message.web_app_data.data);
        await sendToAdmin(createManagerMessage(order, ctx.from), ctx.from);
        await ctx.reply(createClientMessage(order), { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });
    } catch (e) { console.error(e); }
});

// 4. ПЕРЕПИСКА
bot.on('message', async (ctx, next) => {
    if (ctx.message.is_topic_message || ctx.message.is_automatic_forward) return next();

    const chatId = ctx.chat.id.toString();
    
    // А) Клиент -> Бот
    if (ctx.chat.type === 'private') {
        await copyToAdmin(ctx);
    } 
    // Б) Админ -> Клиент (в топике)
    else if (chatId === ADMIN_GROUP_ID && ctx.message.message_thread_id) {
        const userId = await kv.get(`thread:${ctx.message.message_thread_id}`);
        if (userId) {
            try {
                await ctx.copyMessage(userId);
            } catch (e) { console.error("Ошибка ответа:", e); }
        }
    }
});

// ЗАПУСК
const handleUpdate = webhookCallback(bot, 'http');

module.exports = async (req, res) => {
    if (req.method === 'GET') return res.status(200).send('Bot Running');
    
    if (req.body?.type === 'DIRECT_ORDER') {
        const { order, user } = req.body;
        await sendToAdmin(createManagerMessage(order, user), user);
        
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