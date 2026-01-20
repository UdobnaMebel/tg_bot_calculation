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
        console.error("Create Topic Error:", e.message);
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

// --- ОТПРАВКА С ВОССТАНОВЛЕНИЕМ ---

async function sendToGroupWithRetry(text, user) {
    if (!ADMIN_GROUP_ID) return;
    
    let threadId = await getTopicForUser(user);
    // Если threadId вернулся как объект ошибки
    if (typeof threadId === 'object' && threadId.error) {
        return await bot.api.sendMessage(ADMIN_GROUP_ID, `⚠️ <b>Ошибка создания топика:</b> ${threadId.error}\n\n${text}`, { parse_mode: 'HTML' });
    }

    try {
        await bot.api.sendMessage(ADMIN_GROUP_ID, text, { parse_mode: 'HTML', message_thread_id: threadId });
    } catch (e) {
        // Ошибка (топик удален) - пробуем восстановить
        await kv.del(`user:${user.id}`);
        if (threadId) await kv.del(`thread:${threadId}`);
        
        const newResult = await createNewTopic(user);
        
        if (typeof newResult === 'object' && newResult.error) {
             await bot.api.sendMessage(ADMIN_GROUP_ID, `❌ <b>Сбой восстановления:</b> ${newResult.error}\n\n${text}`, { parse_mode: 'HTML' });
        } else {
             // Попытка 2 в новый топик
             try {
                await bot.api.sendMessage(ADMIN_GROUP_ID, text, { parse_mode: 'HTML', message_thread_id: newResult });
             } catch (e2) {
                // Если и в новый не ушло - в General
                await bot.api.sendMessage(ADMIN_GROUP_ID, `🔥 <b>Фатальная ошибка:</b> ${e2.message}\n\n${text}`, { parse_mode: 'HTML' });
             }
        }
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

    try {
        await ctx.copyMessage(ADMIN_GROUP_ID, { message_thread_id: threadId });
    } catch (e) {
        // Ошибка пересылки (топик удален?) -> Восстанавливаем
        await kv.del(`user:${user.id}`);
        const newResult = await createNewTopic(user);
        
        if (typeof newResult === 'object' && newResult.error) {
            await ctx.copyMessage(ADMIN_GROUP_ID); // В General
        } else {
            // Попытка 2 в новый топик
            try {
                await ctx.copyMessage(ADMIN_GROUP_ID, { message_thread_id: newResult });
            } catch (e2) {
                // Если и тут не вышло - в General
                await ctx.copyMessage(ADMIN_GROUP_ID);
            }
        }
    }
}

// ==========================================
// ОБРАБОТЧИКИ
// ==========================================

// 1. КОМАНДЫ (ИГНОРИРУЮТСЯ СЛУШАТЕЛЕМ НИЖЕ)
bot.command('start', async (ctx) => {
    if (ctx.chat.type === 'private') {
        await ctx.reply('👋 Конструктор готов! Нажмите кнопку ниже.\n\n💬 Пишите сюда — менеджер ответит.', { reply_markup: KEYBOARD });
        // Уведомляем админа, чтобы создался топик
        await sendToGroupWithRetry(`👋 Пользователь нажал <b>/start</b>`, ctx.from);
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
        await sendToGroupWithRetry(createManagerMessage(order, ctx.from), ctx.from);
        await ctx.reply(createClientMessage(order), { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });
    } catch (e) { console.error(e); }
});

// 3. ПЕРЕПИСКА (КЛИЕНТ <-> АДМИН)
bot.on('message', async (ctx, next) => {
    // ВАЖНО: Игнорируем команды (они обработаны выше), служебные сообщения и топики
    // ctx.hasCommand('start') вернет true если это команда /start
    if (
        ctx.message.is_topic_message || 
        ctx.message.is_automatic_forward || 
        ctx.hasCommand("start") || 
        ctx.hasCommand("reset")
    ) {
        return next();
    }

    const chatId = ctx.chat.id.toString();
    
    // А) Клиент пишет боту
    if (ctx.chat.type === 'private') {
        await copyToGroupWithRetry(ctx);
    } 
    // Б) Админ пишет в Группе (в Топике)
    else if (chatId === ADMIN_GROUP_ID && ctx.message.message_thread_id) {
        const userId = await kv.get(`thread:${ctx.message.message_thread_id}`);
        if (userId) {
            try {
                await ctx.copyMessage(userId);
                // Можно поставить реакцию, чтобы знать, что ушло
                try { await ctx.react('👍'); } catch(e) {}
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