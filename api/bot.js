const { Bot, webhookCallback } = require('grammy');
const Redis = require('ioredis');

const bot = new Bot(process.env.BOT_TOKEN);
const ADMIN_GROUP_ID = (process.env.MANAGER_CHAT_ID || '').trim().replace(/['"]/g, ''); 
const webAppUrl = process.env.WEBAPP_URL; 

// === ПОДКЛЮЧЕНИЕ К БАЗЕ С TLS ===
const redis = new Redis(process.env.REDIS_URL, {
    tls: { rejectUnauthorized: false },
    maxRetriesPerRequest: 1
}); 
redis.on('error', (err) => console.error('🔴 Redis Error:', err));
redis.on('connect', () => console.log('🟢 Redis Connected!'));

const KEYBOARD = {
    keyboard: [[{ text: "✅ Открыть конструктор", web_app: { url: webAppUrl } }]],
    resize_keyboard: true
};

// --- КОМАНДА ПРОВЕРКИ БАЗЫ ---
bot.command('dbtest', async (ctx) => {
    try {
        await ctx.reply("⏳ Проверяю базу данных...");
        
        // Тест записи
        await redis.set('test_key', 'Hello Redis!');
        // Тест чтения
        const value = await redis.get('test_key');
        
        if (value === 'Hello Redis!') {
            await ctx.reply(`✅ <b>База работает!</b>\nОтвет базы: ${value}`, { parse_mode: 'HTML' });
        } else {
            await ctx.reply(`❌ <b>Ошибка данных:</b> Записали одно, получили "${value}"`, { parse_mode: 'HTML' });
        }
    } catch (e) {
        await ctx.reply(`❌ <b>Ошибка подключения:</b>\n${e.message}`, { parse_mode: 'HTML' });
    }
});

// --- ФУНКЦИИ ТОПИКОВ ---

async function createNewTopic(user) {
    try {
        const dateStr = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        const nameClean = `${user.first_name} ${user.last_name||''}`.trim().substring(0, 30);
        const topicName = `${nameClean} [${dateStr}]`;

        const topic = await bot.api.createForumTopic(ADMIN_GROUP_ID, topicName);
        
        await redis.set(`user:${user.id}`, topic.message_thread_id);
        await redis.set(`thread:${topic.message_thread_id}`, user.id);
        
        return topic.message_thread_id;
    } catch (e) {
        console.error("Error creating topic:", e);
        return { error: e.message };
    }
}

async function getTopicForUser(user) {
    try {
        const cachedId = await redis.get(`user:${user.id}`);
        if (cachedId) return parseInt(cachedId);
    } catch (e) {
        console.error("Redis read error:", e);
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
    let msg = `✅ <b>Ваша заявка принята!</b>\nМенеджер скоро свяжется с вами.\n\n📋 <b>Заказ:</b>\n`;
    order.items.forEach(i => msg += `${i.name} (${i.color})\n`);
    msg += `\n💰 <b>Итого:</b> ${order.total}`;
    return msg;
}

// --- ОТПРАВКА ---

async function sendToGroupWithRetry(text, user) {
    if (!ADMIN_GROUP_ID) return;
    
    let result = await getTopicForUser(user);
    let threadId = (typeof result === 'object' && result?.error) ? null : result;
    
    if (typeof result === 'object' && result?.error) {
        // Если ошибка создания - пишем в General
        return await bot.api.sendMessage(ADMIN_GROUP_ID, `⚠️ <b>Ошибка тикета:</b> ${result.error}\n\n${text}`, { parse_mode: 'HTML' });
    }

    try {
        await bot.api.sendMessage(ADMIN_GROUP_ID, text, { parse_mode: 'HTML', message_thread_id: threadId });
    } catch (e) {
        // Топик удален?
        await redis.del(`user:${user.id}`);
        if (threadId) await redis.del(`thread:${threadId}`);
        
        result = await createNewTopic(user);
        threadId = (typeof result === 'object' && result?.error) ? null : result;
        
        await bot.api.sendMessage(ADMIN_GROUP_ID, text, { 
            parse_mode: 'HTML', 
            message_thread_id: threadId || undefined 
        });
    }
}

async function copyToGroupWithRetry(ctx) {
    if (!ADMIN_GROUP_ID) return;
    const user = ctx.from;

    let result = await getTopicForUser(user);
    let threadId = (typeof result === 'object' && result?.error) ? null : result;

    if (typeof result === 'object' && result?.error) {
        return await ctx.copyMessage(ADMIN_GROUP_ID);
    }

    try {
        await ctx.copyMessage(ADMIN_GROUP_ID, { message_thread_id: threadId });
    } catch (e) {
        await redis.del(`user:${user.id}`);
        const newTopic = await createNewTopic(user);
        
        if (typeof newTopic === 'object' && newTopic.error) {
            await ctx.copyMessage(ADMIN_GROUP_ID);
        } else {
            await ctx.copyMessage(ADMIN_GROUP_ID, { message_thread_id: newTopic });
        }
    }
}

// === ОБРАБОТЧИКИ ===

bot.on('message', async (ctx, next) => {
    if (ctx.message.web_app_data || ctx.message.is_automatic_forward) return next();

    const chatId = ctx.chat.id.toString();
    
    if (ctx.chat.type === 'private') {
        await copyToGroupWithRetry(ctx);
    } 
    else if (chatId === ADMIN_GROUP_ID && ctx.message.message_thread_id) {
        const userId = await redis.get(`thread:${ctx.message.message_thread_id}`);
        if (userId) {
            try {
                await ctx.copyMessage(userId);
            } catch (e) {}
        }
    }
    return next();
});

bot.on('message:web_app_data', async (ctx) => {
    try {
        const { data } = ctx.message.web_app_data;
        const order = JSON.parse(data);
        await sendToGroupWithRetry(createManagerMessage(order, ctx.from), ctx.from);
        await ctx.reply(createClientMessage(order), { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });
    } catch (e) { console.error(e); }
});

const handleUpdate = webhookCallback(bot, 'http');

module.exports = async (req, res) => {
    if (req.method === 'GET') return res.status(200).send('Bot Running');
    if (req.body?.type === 'DIRECT_ORDER') {
        await sendToGroupWithRetry(createManagerMessage(req.body.order, req.body.user), req.body.user);
        if (req.body.user.id) {
            try {
                await bot.api.sendMessage(req.body.user.id, createClientMessage(req.body.order), { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });
            } catch (e) {}
        }
        return res.status(200).json({ success: true });
    }
    try { return await handleUpdate(req, res); } catch (e) { return res.status(500).send('Error'); }
};

bot.command('start', async (ctx) => {
    if (ctx.chat.type === 'private') await ctx.reply('👋 Конструктор готов! Нажмите кнопку ниже.', { reply_markup: KEYBOARD });
});