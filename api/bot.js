const { Bot, webhookCallback } = require('grammy');
const { kv } = require('@vercel/kv');

const bot = new Bot(process.env.BOT_TOKEN);
// Очистка ID
const ADMIN_GROUP_ID = (process.env.MANAGER_CHAT_ID || '').trim().replace(/['"]/g, ''); 
const webAppUrl = process.env.WEBAPP_URL; 

const KEYBOARD = {
    keyboard: [[{ text: "✅ Открыть конструктор", web_app: { url: webAppUrl } }]],
    resize_keyboard: true
};

// --- КОМАНДЫ ---

bot.command('start', async (ctx) => {
    if (ctx.chat.type === 'private') {
        await ctx.reply('👋 Конструктор готов! Нажмите кнопку ниже.\n\n💬 Пишите сюда — менеджер ответит.', { reply_markup: KEYBOARD });
    }
});

bot.command('reset', async (ctx) => {
    await kv.del(`user:${ctx.from.id}`);
    await ctx.reply('✅ Сессия сброшена.');
});

// --- ТОПИКИ ---

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
        return { error: e.message };
    }
}

async function getTopicForUser(user) {
    const cachedId = await kv.get(`user:${user.id}`);
    if (cachedId) return parseInt(cachedId);
    return await createNewTopic(user);
}

// --- ПРОВЕРКА ЖИВ ЛИ ТОПИК ---
// Посылаем действие "печатает". Если топик удален, это упадет с ошибкой.
async function isTopicAlive(threadId) {
    try {
        await bot.api.sendChatAction(ADMIN_GROUP_ID, 'typing', { message_thread_id: threadId });
        return true;
    } catch (e) {
        return false;
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
    let msg = `✅ <b>Заявка принята!</b>\nМенеджер скоро свяжется с вами.\n\n📋 <b>Заказ:</b>\n`;
    order.items.forEach(i => msg += `${i.name} (${i.color})\n`);
    msg += `\n💰 <b>Итого:</b> ${order.total}`;
    return msg;
}

// --- ОТПРАВКА С ПРОВЕРКОЙ ---

async function sendToGroupWithRetry(text, user) {
    if (!ADMIN_GROUP_ID) return;
    
    let threadId = await getTopicForUser(user);
    
    // Проверка на ошибку создания
    if (typeof threadId === 'object' && threadId.error) {
        return await bot.api.sendMessage(ADMIN_GROUP_ID, `⚠️ <b>Ошибка (Create):</b> ${threadId.error}\n\n${text}`, { parse_mode: 'HTML' });
    }

    // ПРОВЕРКА: Жив ли топик?
    const isAlive = await isTopicAlive(threadId);
    
    if (!isAlive) {
        // Топик мертв, восстанавливаем
        await kv.del(`user:${user.id}`);
        await kv.del(`thread:${threadId}`); // Чистим старый
        threadId = await createNewTopic(user); // Создаем новый
        
        // Уведомляем, если создание не удалось
        if (typeof threadId === 'object' && threadId.error) {
             return await bot.api.sendMessage(ADMIN_GROUP_ID, `❌ <b>Сбой восстановления:</b> ${threadId.error}\n\n${text}`, { parse_mode: 'HTML' });
        }
        
        // Уведомляем о восстановлении
        await bot.api.sendMessage(ADMIN_GROUP_ID, `♻️ Топик был удален. Создан новый для ${user.first_name}.`, { message_thread_id: threadId });
    }

    // Отправляем (теперь точно знаем, что ID валидный)
    try {
        await bot.api.sendMessage(ADMIN_GROUP_ID, text, { parse_mode: 'HTML', message_thread_id: threadId });
    } catch (e) {
        // Если даже после проверки упало (крайний случай)
        await bot.api.sendMessage(ADMIN_GROUP_ID, `🔥 <b>Критический сбой:</b> ${e.message}\n\n${text}`, { parse_mode: 'HTML' });
    }
}

async function copyToGroupWithRetry(ctx) {
    if (!ADMIN_GROUP_ID) return;
    const user = ctx.from;

    let threadId = await getTopicForUser(user);
    if (typeof threadId === 'object' && threadId.error) {
        await bot.api.sendMessage(ADMIN_GROUP_ID, `⚠️ <b>Ошибка тикета:</b> ${threadId.error}`);
        return await ctx.copyMessage(ADMIN_GROUP_ID);
    }

    // ПРОВЕРКА ЖИВУЧЕСТИ
    const isAlive = await isTopicAlive(threadId);

    if (!isAlive) {
        await kv.del(`user:${user.id}`);
        await kv.del(`thread:${threadId}`);
        threadId = await createNewTopic(user);
        
        if (typeof threadId === 'object' && threadId.error) {
            await bot.api.sendMessage(ADMIN_GROUP_ID, `❌ <b>Сбой чата:</b> ${threadId.error}`);
            return await ctx.copyMessage(ADMIN_GROUP_ID);
        }
    }

    try {
        await ctx.copyMessage(ADMIN_GROUP_ID, { message_thread_id: threadId });
    } catch (e) {
        // Fallback в General с ошибкой
        await bot.api.sendMessage(ADMIN_GROUP_ID, `🔥 Ошибка: ${e.message}`);
        await ctx.copyMessage(ADMIN_GROUP_ID);
    }
}

// === ОБРАБОТЧИКИ ===

// 1. ЗАКАЗ
bot.on('message:web_app_data', async (ctx) => {
    try {
        const { data } = ctx.message.web_app_data;
        const order = JSON.parse(data);
        await sendToGroupWithRetry(createManagerMessage(order, ctx.from), ctx.from);
        await ctx.reply(createClientMessage(order), { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });
    } catch (e) { console.error(e); }
});

// 2. ПЕРЕПИСКА
bot.on('message', async (ctx, next) => {
    if (ctx.message.is_topic_message || ctx.message.is_automatic_forward) return next();

    const chatId = ctx.chat.id.toString();
    
    // Клиент -> Бот
    if (ctx.chat.type === 'private') {
        await copyToGroupWithRetry(ctx);
    } 
    // Админ -> Клиент
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