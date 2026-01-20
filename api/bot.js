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
        
        await kv.set(`user:${user.id}`, topic.message_thread_id);
        await kv.set(`thread:${topic.message_thread_id}`, user.id);
        
        return { success: true, id: topic.message_thread_id };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// 2. Получение ID (С ПРОВЕРКОЙ ЖИВУЧЕСТИ)
async function getValidTopicId(user) {
    // Шаг А: Читаем из базы
    const cachedId = await kv.get(`user:${user.id}`);
    
    if (cachedId) {
        const threadId = parseInt(cachedId);
        // Шаг Б: ПРОВЕРКА. Пытаемся отправить действие "печатает" в этот топик.
        // Если топик удален, это выбросит ошибку.
        try {
            await bot.api.sendChatAction(ADMIN_GROUP_ID, 'typing', { message_thread_id: threadId });
            return { success: true, id: threadId, isNew: false }; // Топик жив
        } catch (e) {
            // Если ошибка — значит топик мертв. Чистим базу.
            await kv.del(`user:${user.id}`);
            await kv.del(`thread:${threadId}`);
            
            // Сообщаем админу в General, что заметили удаление
            await bot.api.sendMessage(ADMIN_GROUP_ID, `♻️ <b>Топик #${threadId} не найден (удален?).</b>\nСоздаю новый для ${user.first_name}...`, { parse_mode: 'HTML' });
        }
    }

    // Шаг В: Создаем новый (если старого нет или он был удален)
    const result = await createNewTopic(user);
    if (result.success) {
        return { success: true, id: result.id, isNew: true };
    } else {
        return { success: false, error: result.error };
    }
}

// --- ГЕНЕРАЦИЯ ТЕКСТОВ ---

function createManagerMessage(order, user) {
    let msg = `🆕 <b>НОВЫЙ ЗАКАЗ</b>\n\n👤 <b>Клиент:</b> @${user.username||'нет'} (ID: ${user.id})\n\n📋 <b>Состав:</b>\n`;
    order.items.forEach(i => msg += `${i.name} (${i.color})\n   └ ${i.price ? i.price.toLocaleString() + ' ₽' : 'Вкл'}\n`);
    msg += `\n💰 <b>Итого:</b> ${order.total}\n📏 ${order.dims}\n⚖️ ${order.weight.replace('Вес:', '<b>Вес:</b>')}`;
    return msg;
}

function createClientMessage(order) {
    let msg = `✅ <b>Заявка принята!</b>\nМенеджер скоро свяжется с вами.\n\n📋 <b>Заказ:</b>\n`;
    order.items.forEach(i => msg += `${i.name} (${i.color})\n`);
    msg += `\n💰 <b>Итого:</b> ${order.total}`;
    return msg;
}

// --- ОТПРАВКА ---

async function sendToGroupSafe(text, user) {
    if (!ADMIN_GROUP_ID) return;

    const topic = await getValidTopicId(user);

    if (topic.success) {
        try {
            await bot.api.sendMessage(ADMIN_GROUP_ID, text, { parse_mode: 'HTML', message_thread_id: topic.id });
        } catch (e) {
            // Если даже после проверки не ушло (редкий кейс)
            await bot.api.sendMessage(ADMIN_GROUP_ID, `🔥 <b>Сбой отправки:</b> ${e.message}\n\n${text}`, { parse_mode: 'HTML' });
        }
    } else {
        // Если не удалось создать топик
        await bot.api.sendMessage(ADMIN_GROUP_ID, `🛑 <b>Ошибка создания топика:</b> ${topic.error}\n\n${text}`, { parse_mode: 'HTML' });
    }
}

async function copyToGroupSafe(ctx) {
    if (!ADMIN_GROUP_ID) return;
    const user = ctx.from;

    const topic = await getValidTopicId(user);

    if (topic.success) {
        try {
            await ctx.copyMessage(ADMIN_GROUP_ID, { message_thread_id: topic.id });
        } catch (e) {
            await ctx.reply("❌ Ошибка доставки сообщения менеджеру.");
            await bot.api.sendMessage(ADMIN_GROUP_ID, `🔥 <b>Сбой пересылки от ${user.first_name}:</b> ${e.message}`, { parse_mode: 'HTML' });
        }
    } else {
        await ctx.reply("❌ Ошибка связи с менеджером (нет топика).");
        await bot.api.sendMessage(ADMIN_GROUP_ID, `🛑 <b>Не удалось создать топик для ${user.first_name}:</b> ${topic.error}`, { parse_mode: 'HTML' });
        // Фолбэк в General
        await ctx.copyMessage(ADMIN_GROUP_ID);
    }
}

// ==========================================
// ОБРАБОТЧИКИ
// ==========================================

// 1. КОМАНДЫ
bot.command('start', async (ctx) => {
    if (ctx.chat.type === 'private') {
        await ctx.reply('👋 Конструктор готов! Нажмите кнопку ниже.\n\n💬 Пишите сюда — менеджер ответит.', { reply_markup: KEYBOARD });
        await sendToGroupSafe(`👋 Пользователь нажал <b>/start</b>`, ctx.from);
    }
});

bot.command('reset', async (ctx) => {
    await kv.del(`user:${ctx.from.id}`);
    await ctx.reply('✅ Сессия сброшена.');
});

// 2. ЗАКАЗ (WebApp Data)
bot.on('message:web_app_data', async (ctx) => {
    try {
        const order = JSON.parse(ctx.message.web_app_data.data);
        await sendToGroupSafe(createManagerMessage(order, ctx.from), ctx.from);
        await ctx.reply(createClientMessage(order), { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });
    } catch (e) { console.error(e); }
});

// 3. ПЕРЕПИСКА
bot.on('message', async (ctx, next) => {
    // Фильтр служебных сообщений
    if (
        ctx.message.is_topic_message || 
        ctx.message.is_automatic_forward || 
        ctx.hasCommand("start")
    ) {
        return next();
    }

    const chatId = ctx.chat.id.toString();
    
    // А) Клиент -> Бот
    if (ctx.chat.type === 'private') {
        await copyToGroupSafe(ctx);
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

const handleUpdate = webhookCallback(bot, 'http');

module.exports = async (req, res) => {
    if (req.method === 'GET') return res.status(200).send('Bot Running');
    
    if (req.body?.type === 'DIRECT_ORDER') {
        const { order, user } = req.body;
        await sendToGroupSafe(createManagerMessage(order, user), user);
        
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