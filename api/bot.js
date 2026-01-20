const { Bot, webhookCallback } = require('grammy');
const { kv } = require('@vercel/kv');

const bot = new Bot(process.env.BOT_TOKEN);
const ADMIN_GROUP_ID = (process.env.MANAGER_CHAT_ID || '').trim().replace(/['"]/g, ''); 
const webAppUrl = process.env.WEBAPP_URL; 

const KEYBOARD = {
    keyboard: [[{ text: "✅ Открыть конструктор", web_app: { url: webAppUrl } }]],
    resize_keyboard: true
};

// --- ФУНКЦИИ ТОПИКОВ ---

async function createNewTopic(user) {
    try {
        const randomId = Math.floor(Math.random() * 1000);
        const nameClean = `${user.first_name} ${user.last_name||''}`.trim().substring(0, 30);
        const topicName = `${nameClean} #${randomId}`;

        const topic = await bot.api.createForumTopic(ADMIN_GROUP_ID, topicName);
        
        await kv.set(`user:${user.id}`, topic.message_thread_id);
        await kv.set(`thread:${topic.message_thread_id}`, user.id);
        
        return topic.message_thread_id;
    } catch (e) {
        console.error("[ERROR] Create Topic:", e.message);
        return { error: e.message };
    }
}

async function getTopicForUser(user) {
    const cachedId = await kv.get(`user:${user.id}`);
    if (cachedId && !isNaN(parseInt(cachedId)) && parseInt(cachedId) > 0) {
        return parseInt(cachedId);
    }
    return await createNewTopic(user);
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

// --- ОТПРАВКА С ЛЕЧЕНИЕМ ---

async function sendToGroupWithRetry(text, user) {
    if (!ADMIN_GROUP_ID) return;
    
    let threadId = await getTopicForUser(user);
    if (typeof threadId === 'object' && threadId.error) {
        return await bot.api.sendMessage(ADMIN_GROUP_ID, `⚠️ <b>Ошибка тикета:</b> ${threadId.error}\n\n${text}`, { parse_mode: 'HTML' });
    }

    try {
        await bot.api.sendMessage(ADMIN_GROUP_ID, text, { parse_mode: 'HTML', message_thread_id: threadId });
    } catch (e) {
        // Ошибка - пробуем пересоздать
        console.log(`Ошибка отправки в ${threadId}, пересоздаем...`);
        await kv.del(`user:${user.id}`);
        // Не удаляем thread:ID, вдруг это был сбой сети, а не удаление
        
        const newResult = await createNewTopic(user);
        if (typeof newResult === 'object' && newResult.error) {
             await bot.api.sendMessage(ADMIN_GROUP_ID, `❌ <b>Сбой:</b> ${newResult.error}\n\n${text}`, { parse_mode: 'HTML' });
        } else {
             await bot.api.sendMessage(ADMIN_GROUP_ID, text, { parse_mode: 'HTML', message_thread_id: newResult });
        }
    }
}

async function copyToGroupWithRetry(ctx) {
    if (!ADMIN_GROUP_ID) return;
    const user = ctx.from;

    let threadId = await getTopicForUser(user);
    if (typeof threadId === 'object' && threadId.error) {
        await bot.api.sendMessage(ADMIN_GROUP_ID, `⚠️ <b>Ошибка:</b> ${threadId.error}\nСообщение:`, { parse_mode: 'HTML' });
        return await ctx.copyMessage(ADMIN_GROUP_ID);
    }

    try {
        await ctx.copyMessage(ADMIN_GROUP_ID, { message_thread_id: threadId });
    } catch (e) {
        await kv.del(`user:${user.id}`);
        const newResult = await createNewTopic(user);
        
        if (typeof newResult === 'object' && newResult.error) {
            await ctx.copyMessage(ADMIN_GROUP_ID); // General
        } else {
            await ctx.copyMessage(ADMIN_GROUP_ID, { message_thread_id: newResult });
        }
    }
}

// === АВТОМАТИЧЕСКАЯ ОЧИСТКА (НОВОЕ!) ===
// Слушаем события "Топик закрыт" или "Топик удален"
// :forum_topic_closed - если просто закрыли
// :forum_topic_deleted - если удалили совсем (в версиях API может отличаться, ловим все служебные)

bot.on([':forum_topic_closed', ':forum_topic_reopened', ':forum_topic_created', ':forum_topic_edited'], async (ctx) => {
    // Просто логируем для инфо
    console.log("Служебное событие топика:", ctx.update);
});

// ГЛАВНОЕ: Если топик удален, чистим базу
// (Событие forum_topic_deleted приходит как service message)
bot.on('message:forum_topic_deleted', async (ctx) => {
    const threadId = ctx.message.message_thread_id;
    console.log(`🗑 Топик ${threadId} был удален админом.`);
    
    // Ищем, чей это был топик
    const userId = await kv.get(`thread:${threadId}`);
    
    if (userId) {
        await kv.del(`user:${userId}`);
        await kv.del(`thread:${threadId}`);
        console.log(`✅ Данные пользователя ${userId} очищены.`);
    }
});


// === ОБРАБОТЧИКИ ===

bot.on('message', async (ctx, next) => {
    if (ctx.message.web_app_data || ctx.message.is_automatic_forward) return next();

    const chatId = ctx.chat.id.toString();
    
    // 1. Клиент -> Бот
    if (ctx.chat.type === 'private') {
        await copyToGroupWithRetry(ctx);
    } 
    // 2. Админ -> Клиент
    else if (chatId === ADMIN_GROUP_ID && ctx.message.message_thread_id) {
        const userId = await kv.get(`thread:${ctx.message.message_thread_id}`);
        if (userId) {
            try {
                await ctx.copyMessage(userId);
            } catch (e) { console.error("Ошибка ответа:", e); }
        }
    }
    return next();
});

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