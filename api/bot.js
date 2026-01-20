const { Bot, webhookCallback } = require('grammy');
const { kv } = require('@vercel/kv');

const bot = new Bot(process.env.BOT_TOKEN);
const ADMIN_GROUP_ID = String(process.env.MANAGER_CHAT_ID || '').trim().replace(/['"]/g, ''); 
const webAppUrl = process.env.WEBAPP_URL; 

const KEYBOARD = {
    keyboard: [[{ text: "✅ Открыть конструктор", web_app: { url: webAppUrl } }]],
    resize_keyboard: true
};

// --- 1. ФУНКЦИИ БАЗЫ ---

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
        console.error("Create Topic Error:", e);
        return null;
    }
}

async function getTopicId(user) {
    const cachedId = await kv.get(`user:${user.id}`);
    if (cachedId) return parseInt(cachedId);
    return await createNewTopic(user);
}

// --- 2. ОТПРАВКА С ВОССТАНОВЛЕНИЕМ ---

// Отправка текста (Заказы, Старт)
async function sendToAdmin(text, user) {
    if (!ADMIN_GROUP_ID) return;
    
    // Попытка 1: Получаем ID (из кэша или создаем)
    let threadId = await getTopicId(user);

    try {
        await bot.api.sendMessage(ADMIN_GROUP_ID, text, { parse_mode: 'HTML', message_thread_id: threadId });
    } catch (e) {
        // Ошибка (например, топик удален) -> Удаляем кэш -> Создаем новый -> Шлем снова
        console.log(`Ошибка отправки в ${threadId}, пересоздаем...`);
        await kv.del(`user:${user.id}`);
        threadId = await createNewTopic(user);
        
        try {
            await bot.api.sendMessage(ADMIN_GROUP_ID, text, { parse_mode: 'HTML', message_thread_id: threadId });
        } catch (e2) {
            // Фолбэк в General
            await bot.api.sendMessage(ADMIN_GROUP_ID, text, { parse_mode: 'HTML' });
        }
    }
}

// Пересылка сообщений (Чат)
async function forwardToAdmin(ctx) {
    if (!ADMIN_GROUP_ID) return;
    const user = ctx.from;
    
    let threadId = await getTopicId(user);

    try {
        await ctx.copyMessage(ADMIN_GROUP_ID, { message_thread_id: threadId });
    } catch (e) {
        // Ошибка -> Удаляем кэш -> Создаем новый -> Шлем снова
        console.log(`Ошибка пересылки в ${threadId}, пересоздаем...`);
        await kv.del(`user:${user.id}`);
        threadId = await createNewTopic(user);
        
        try {
            await ctx.copyMessage(ADMIN_GROUP_ID, { message_thread_id: threadId });
        } catch (e2) {
            // Фолбэк в General
            await ctx.copyMessage(ADMIN_GROUP_ID);
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
    let msg = `✅ <b>Заявка принята!</b>\nМенеджер скоро свяжется с вами.\n\n📋 <b>Заказ:</b>\n`;
    order.items.forEach(i => msg += `${i.name} (${i.color})\n`);
    msg += `\n💰 <b>Итого:</b> ${order.total}`;
    return msg;
}

// ==========================================
// ОБРАБОТЧИКИ
// ==========================================

// 1. КОМАНДЫ
bot.command('start', async (ctx) => {
    if (ctx.chat.type === 'private') {
        await ctx.reply('👋 Конструктор готов! Нажмите кнопку ниже.', { reply_markup: KEYBOARD });
        await sendToAdmin(`👋 Пользователь нажал <b>/start</b>`, ctx.from);
    }
});

// 2. ЗАКАЗЫ (WebApp)
bot.on('message:web_app_data', async (ctx) => {
    try {
        const order = JSON.parse(ctx.message.web_app_data.data);
        await sendToAdmin(createManagerMessage(order, ctx.from), ctx.from);
        await ctx.reply(createClientMessage(order), { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });
    } catch (e) { console.error(e); }
});

// 3. ПЕРЕПИСКА
bot.on('message', async (ctx, next) => {
    // Игнорируем авто-пересылки каналов
    if (ctx.message.is_automatic_forward) return;

    const chatId = String(ctx.chat.id);
    
    // А) КЛИЕНТ ПИШЕТ (В ЛИЧКУ)
    if (ctx.chat.type === 'private') {
        await forwardToAdmin(ctx);
    } 
    
    // Б) АДМИН ПИШЕТ (В ГРУППЕ)
    else if (chatId === ADMIN_GROUP_ID) {
        
        // ВАЖНО: Игнорируем служебные сообщения "Топик создан/изменен"
        // message_thread_id есть у всех сообщений в топике, но is_topic_message = true у служебных о создании
        if (ctx.message.forum_topic_created || ctx.message.forum_topic_edited || ctx.message.forum_topic_closed || ctx.message.forum_topic_reopened) {
            return;
        }

        const threadId = ctx.message.message_thread_id;
        
        if (threadId) {
            const userId = await kv.get(`thread:${threadId}`);
            
            if (userId) {
                try {
                    // ЕСЛИ ТЕКСТ -> Шлем sendMessage (надежнее, чем copy)
                    if (ctx.message.text) {
                        await bot.api.sendMessage(userId, ctx.message.text);
                    } 
                    // ЕСЛИ КАРТИНКА/ФАЙЛ -> Копируем
                    else {
                        await ctx.copyMessage(userId);
                    }
                    
                    // Реакция успеха
                    await ctx.react('👍'); 
                } catch (e) {
                    await ctx.reply(`❌ Ошибка: ${e.description}`);
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