const { Bot, webhookCallback } = require('grammy');
const { kv } = require('@vercel/kv');

const bot = new Bot(process.env.BOT_TOKEN);
const ADMIN_GROUP_ID = String(process.env.MANAGER_CHAT_ID || '').trim().replace(/['"]/g, ''); 
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
        console.error("Topic Error:", e.message);
        return null;
    }
}

async function getTopicId(user) {
    const cachedId = await kv.get(`user:${user.id}`);
    if (cachedId) return parseInt(cachedId);
    return await createNewTopic(user);
}

// --- ОТПРАВКА С ЗАЩИТОЙ (ТЕКСТ) ---
// Используется для /start и Заявок
async function sendToAdmin(text, user) {
    if (!ADMIN_GROUP_ID) return;
    
    let threadId = await getTopicId(user);

    try {
        // Попытка 1
        await bot.api.sendMessage(ADMIN_GROUP_ID, text, { parse_mode: 'HTML', message_thread_id: threadId || undefined });
    } catch (e) {
        // Если ошибка - удаляем кэш и пробуем снова в новый топик
        await kv.del(`user:${user.id}`);
        threadId = await createNewTopic(user);
        
        try {
            await bot.api.sendMessage(ADMIN_GROUP_ID, text, { parse_mode: 'HTML', message_thread_id: threadId || undefined });
        } catch (e2) {
            // Если совсем не вышло - в General
            await bot.api.sendMessage(ADMIN_GROUP_ID, text, { parse_mode: 'HTML' });
        }
    }
}

// --- ПЕРЕСЫЛКА С ЗАЩИТОЙ (СООБЩЕНИЯ) ---
// Используется для сообщений клиента
async function forwardToAdmin(ctx) {
    if (!ADMIN_GROUP_ID) return;
    const user = ctx.from;
    
    let threadId = await getTopicId(user);

    try {
        // Попытка 1
        await ctx.copyMessage(ADMIN_GROUP_ID, { message_thread_id: threadId || undefined });
    } catch (e) {
        // Ошибка - пробуем снова
        await kv.del(`user:${user.id}`);
        threadId = await createNewTopic(user);
        
        try {
            await ctx.copyMessage(ADMIN_GROUP_ID, { message_thread_id: threadId || undefined });
        } catch (e2) {
            await ctx.copyMessage(ADMIN_GROUP_ID); // В General
        }
    }
}

// --- ТЕКСТЫ ---

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

// ==========================================
// ОБРАБОТЧИКИ
// ==========================================

// 1. СТАРТ
bot.command('start', async (ctx) => {
    if (ctx.chat.type === 'private') {
        await ctx.reply('👋 Конструктор готов!', { reply_markup: KEYBOARD });
        await sendToAdmin(`👋 Пользователь нажал <b>/start</b>`, ctx.from);
    }
});

// 2. ЗАКАЗ (Кнопка)
bot.on('message:web_app_data', async (ctx) => {
    try {
        const order = JSON.parse(ctx.message.web_app_data.data);
        await sendToAdmin(createManagerMessage(order, ctx.from), ctx.from);
        await ctx.reply(createClientMessage(order), { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });
    } catch (e) { console.error(e); }
});

// 3. ПЕРЕПИСКА (ЧАТ)
bot.on('message', async (ctx, next) => {
    // Игнорируем только системные авто-репосты каналов
    if (ctx.message.is_automatic_forward) return;

    const chatId = String(ctx.chat.id);
    
    // А) КЛИЕНТ ПИШЕТ БОТУ
    if (ctx.chat.type === 'private') {
        await forwardToAdmin(ctx);
    } 
    
    // Б) АДМИН ОТВЕЧАЕТ В ТОПИКЕ
    else if (chatId === ADMIN_GROUP_ID) {
        const threadId = ctx.message.message_thread_id;
        
        // Если это топик (не General)
        if (threadId) {
            const userId = await kv.get(`thread:${threadId}`);
            
            if (userId) {
                try {
                    await ctx.copyMessage(userId);
                    await ctx.react('👍'); // Подтверждение успеха
                } catch (e) {
                    await ctx.reply(`❌ Не доставлено: ${e.description}`);
                }
            }
        }
    }
});

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