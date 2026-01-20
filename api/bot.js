const { Bot, webhookCallback } = require('grammy');
const { kv } = require('@vercel/kv');

const bot = new Bot(process.env.BOT_TOKEN);
const ADMIN_GROUP_ID = String(process.env.MANAGER_CHAT_ID || '').trim().replace(/['"]/g, ''); 
const webAppUrl = process.env.WEBAPP_URL; 

const KEYBOARD = {
    keyboard: [[{ text: "✅ Открыть конструктор", web_app: { url: webAppUrl } }]],
    resize_keyboard: true
};

// --- БАЗА ДАННЫХ ---

async function createNewTopic(user) {
    try {
        const randomId = Math.floor(Math.random() * 10000);
        const nameClean = `${user.first_name} ${user.last_name||''}`.trim().substring(0, 30);
        const topicName = `${nameClean} #${randomId}`;

        const topic = await bot.api.createForumTopic(ADMIN_GROUP_ID, topicName);
        
        await kv.set(`user:${user.id}`, topic.message_thread_id);
        await kv.set(`thread:${topic.message_thread_id}`, user.id);
        
        return topic.message_thread_id;
    } catch (e) {
        console.error("Create Topic Error:", e);
        return null;
    }
}

async function getTopicForUser(user) {
    const cachedId = await kv.get(`user:${user.id}`);
    if (cachedId) return parseInt(cachedId);
    return await createNewTopic(user);
}

// --- ГЕНЕРАТОРЫ СООБЩЕНИЙ ---

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

// --- СПЕЦИАЛИЗИРОВАННЫЕ ФУНКЦИИ ОТПРАВКИ ---

// 1. ТОЛЬКО ДЛЯ ТЕКСТА (Заказы, Старт, Уведомления)
async function sendTextToTopic(htmlText, user) {
    if (!ADMIN_GROUP_ID) return;

    let threadId = await getTopicForUser(user);

    try {
        // Попытка 1
        await bot.api.sendMessage(ADMIN_GROUP_ID, htmlText, { parse_mode: 'HTML', message_thread_id: threadId });
    } catch (e) {
        console.log(`Сбой отправки текста в ${threadId}. Создаем новый топик...`);
        
        // Очистка и создание нового
        await kv.del(`user:${user.id}`);
        threadId = await createNewTopic(user);
        
        // Попытка 2 (в новый топик)
        try {
            await bot.api.sendMessage(ADMIN_GROUP_ID, htmlText, { parse_mode: 'HTML', message_thread_id: threadId });
            // Уведомление о смене топика
            await bot.api.sendMessage(ADMIN_GROUP_ID, "ℹ️ <i>Создан новый чат (старый недоступен).</i>", { parse_mode: 'HTML', message_thread_id: threadId });
        } catch (e2) {
            // Фолбэк в General
            await bot.api.sendMessage(ADMIN_GROUP_ID, `🔥 <b>Не доставлено в топик:</b>\n${htmlText}`, { parse_mode: 'HTML' });
        }
    }
}

// 2. ТОЛЬКО ДЛЯ ПЕРЕСЫЛКИ (Сообщения клиента)
async function forwardToTopic(ctx) {
    if (!ADMIN_GROUP_ID) return;
    const user = ctx.from;

    let threadId = await getTopicForUser(user);

    try {
        // Попытка 1
        await ctx.copyMessage(ADMIN_GROUP_ID, { message_thread_id: threadId });
    } catch (e) {
        console.log(`Сбой пересылки в ${threadId}. Создаем новый...`);
        
        // Очистка и создание нового
        await kv.del(`user:${user.id}`);
        threadId = await createNewTopic(user);
        
        // Попытка 2
        try {
            await ctx.copyMessage(ADMIN_GROUP_ID, { message_thread_id: threadId });
        } catch (e2) {
            // Фолбэк в General
            await ctx.copyMessage(ADMIN_GROUP_ID);
        }
    }
}

// ==========================================
// ОБРАБОТЧИКИ
// ==========================================

// 1. ЗАКАЗ ЧЕРЕЗ WEBAPP (Кнопка)
bot.on('message:web_app_data', async (ctx) => {
    try {
        const order = JSON.parse(ctx.message.web_app_data.data);
        
        // 1. Отправляем Менеджеру (Строго текстом!)
        await sendTextToTopic(createManagerMessage(order, ctx.from), ctx.from);
        
        // 2. Ответ Клиенту
        await ctx.reply(createClientMessage(order), { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });
        
    } catch (e) {
        console.error("WebApp Error:", e);
    }
});

// 2. КОМАНДА START
bot.command('start', async (ctx) => {
    if (ctx.chat.type === 'private') {
        await ctx.reply('👋 Конструктор готов! Нажмите кнопку ниже.', { reply_markup: KEYBOARD });
        await sendTextToTopic(`👋 Пользователь нажал <b>/start</b>`, ctx.from);
    }
});

// 3. ПЕРЕПИСКА (Чат)
bot.on('message', async (ctx) => {
    // Игнор служебных
    if (ctx.message.is_topic_message || ctx.message.is_automatic_forward) return;

    const chatId = String(ctx.chat.id);
    
    // А) КЛИЕНТ ПИШЕТ БОТУ
    if (ctx.chat.type === 'private') {
        // Используем функцию ПЕРЕСЫЛКИ
        await forwardToTopic(ctx);
    } 
    
    // Б) АДМИН ПИШЕТ В ГРУППЕ
    else if (chatId === ADMIN_GROUP_ID) {
        const threadId = ctx.message.message_thread_id;
        if (threadId) {
            const userId = await kv.get(`thread:${threadId}`);
            if (userId) {
                try {
                    await ctx.copyMessage(userId);
                    await ctx.react('👍'); // Успех
                } catch (e) {
                    await ctx.reply(`❌ Не ушло: ${e.description}`);
                }
            }
        }
    }
});

const handleUpdate = webhookCallback(bot, 'http');

module.exports = async (req, res) => {
    if (req.method === 'GET') return res.status(200).send('Bot Running');
    
    // ПРЯМОЙ ЗАКАЗ (Fetch)
    if (req.body?.type === 'DIRECT_ORDER') {
        const { order, user } = req.body;
        
        // 1. Менеджеру
        await sendTextToTopic(createManagerMessage(order, user), user);
        
        // 2. Клиенту (если есть ID)
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