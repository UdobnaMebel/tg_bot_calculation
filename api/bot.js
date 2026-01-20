const { Bot, webhookCallback } = require('grammy');
const { kv } = require('@vercel/kv');

const bot = new Bot(process.env.BOT_TOKEN);
const ADMIN_GROUP_ID = (process.env.MANAGER_CHAT_ID || '').trim().replace(/['"]/g, ''); 
const webAppUrl = process.env.WEBAPP_URL; 

const KEYBOARD = {
    keyboard: [[{ text: "✅ Открыть конструктор", web_app: { url: webAppUrl } }]],
    resize_keyboard: true
};

// --- ФУНКЦИИ БАЗЫ ---

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
        console.error("Create Topic Error:", e.message);
        return { error: e.message };
    }
}

async function getTopicForUser(user) {
    const cachedId = await kv.get(`user:${user.id}`);
    if (cachedId && !isNaN(parseInt(cachedId))) return parseInt(cachedId);
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

// --- ОТПРАВКА С ЗАЩИТОЙ ---

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
        await kv.del(`user:${user.id}`);
        if (threadId) await kv.del(`thread:${threadId}`);
        
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
        await bot.api.sendMessage(ADMIN_GROUP_ID, `⚠️ <b>Ошибка:</b> ${threadId.error}`, { parse_mode: 'HTML' });
        return await ctx.copyMessage(ADMIN_GROUP_ID);
    }

    try {
        await ctx.copyMessage(ADMIN_GROUP_ID, { message_thread_id: threadId });
    } catch (e) {
        await kv.del(`user:${user.id}`);
        const newResult = await createNewTopic(user);
        
        if (typeof newResult === 'object' && newResult.error) {
            await ctx.copyMessage(ADMIN_GROUP_ID);
        } else {
            await ctx.copyMessage(ADMIN_GROUP_ID, { message_thread_id: newResult });
        }
    }
}

// ==========================================
// ГЛАВНЫЙ ОБРАБОТЧИК (С ДИАГНОСТИКОЙ)
// ==========================================

bot.on('message', async (ctx, next) => {
    // Игнорируем служебные
    if (ctx.message.is_topic_message || ctx.message.is_automatic_forward) return next();

    const chatId = String(ctx.chat.id);
    
    // 1. КЛИЕНТ ПИШЕТ БОТУ (Личка)
    if (ctx.chat.type === 'private') {
        await copyToGroupWithRetry(ctx);
    } 
    
    // 2. АДМИН ПИШЕТ В ГРУППЕ (Топик)
    else if (chatId === ADMIN_GROUP_ID) {
        
        // --- ДИАГНОСТИКА: Ставим реакцию "Глазки", если бот видит сообщение ---
        try { await ctx.react('👀'); } catch(e) {}
        // ---------------------------------------------------------------------

        const threadId = ctx.message.message_thread_id;
        
        if (threadId) {
            // Ищем юзера в базе
            const userId = await kv.get(`thread:${threadId}`);
            
            if (userId) {
                try {
                    await ctx.copyMessage(userId);
                    // Если ушло успешно - ставим галочку
                    try { await ctx.react('👍'); } catch(e) {}
                } catch (e) { 
                    // Если ошибка отправки - пишем в топик
                    await ctx.reply(`❌ Не ушло: ${e.message}`);
                }
            } else {
                // Если юзер не найден в базе
                await ctx.reply(`⚠️ Бот не знает, чей это топик.\nID топика: ${threadId}\nВ базе: пусто.\n\nПопробуйте сделать новый заказ.`);
            }
        }
    }
    
    return next();
});

// Команда START
bot.command('start', async (ctx) => {
    if (ctx.chat.type === 'private') {
        await ctx.reply('👋 Конструктор готов! Нажмите кнопку ниже.\n\n💬 Пишите сюда — менеджер ответит.', { reply_markup: KEYBOARD });
        await sendToGroupWithRetry(`👋 Пользователь нажал <b>/start</b>`, ctx.from);
    }
});

// WebApp Data
bot.on('message:web_app_data', async (ctx) => {
    try {
        const order = JSON.parse(ctx.message.web_app_data.data);
        await sendToGroupWithRetry(createManagerMessage(order, ctx.from), ctx.from);
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