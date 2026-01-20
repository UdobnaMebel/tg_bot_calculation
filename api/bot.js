const { Bot, webhookCallback } = require('grammy');
const { kv } = require('@vercel/kv');

const bot = new Bot(process.env.BOT_TOKEN);
// Очистка ID группы
const ADMIN_GROUP_ID = (process.env.MANAGER_CHAT_ID || '').trim().replace(/['"]/g, ''); 
const webAppUrl = process.env.WEBAPP_URL; 

const KEYBOARD = {
    keyboard: [[{ text: "✅ Открыть конструктор", web_app: { url: webAppUrl } }]],
    resize_keyboard: true
};

// --- 1. УПРАВЛЕНИЕ ТОПИКАМИ ---

async function createNewTopic(user) {
    try {
        const randomId = Math.floor(Math.random() * 1000);
        const nameClean = `${user.first_name} ${user.last_name||''}`.trim().substring(0, 30);
        const topicName = `${nameClean} #${randomId}`;

        const topic = await bot.api.createForumTopic(ADMIN_GROUP_ID, topicName);
        
        // Сохраняем двустороннюю связь
        await kv.set(`user:${user.id}`, topic.message_thread_id);
        await kv.set(`thread:${topic.message_thread_id}`, user.id);
        
        return topic.message_thread_id;
    } catch (e) {
        console.error("Create Topic Error:", e.message);
        return null;
    }
}

// Получить ID из кэша (без проверок, просто чтение)
async function getCachedTopicId(userId) {
    const cachedId = await kv.get(`user:${userId}`);
    if (cachedId && !isNaN(parseInt(cachedId))) return parseInt(cachedId);
    return null;
}

// --- 2. ГЕНЕРАЦИЯ СООБЩЕНИЙ ---

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

// --- 3. ФУНКЦИИ ОТПРАВКИ (С АВТО-ИСПРАВЛЕНИЕМ) ---

// Отправка текста (Заказы, /start)
async function sendToGroup(text, user) {
    if (!ADMIN_GROUP_ID) return;

    // Шаг 1: Пробуем найти старый топик
    let threadId = await getCachedTopicId(user.id);

    // Если топика нет в базе, создаем сразу
    if (!threadId) {
        threadId = await createNewTopic(user);
    }

    try {
        // Шаг 2: Пробуем отправить
        await bot.api.sendMessage(ADMIN_GROUP_ID, text, { 
            parse_mode: 'HTML', 
            message_thread_id: threadId || undefined 
        });
    } catch (e) {
        // Шаг 3: ЕСЛИ ОШИБКА (Топик удален или не найден)
        console.log(`Ошибка отправки в ${threadId}: ${e.message}. Создаем новый...`);
        
        // Чистка базы
        await kv.del(`user:${user.id}`);
        // Создание нового
        const newThreadId = await createNewTopic(user);
        
        // Шаг 4: Повторная отправка в новый топик
        try {
            await bot.api.sendMessage(ADMIN_GROUP_ID, text, { 
                parse_mode: 'HTML', 
                message_thread_id: newThreadId || undefined 
            });
            // Уведомляем админа, почему создался новый
            if (newThreadId) {
                await bot.api.sendMessage(ADMIN_GROUP_ID, `ℹ️ <i>Предыдущий топик был удален или недоступен. Создан новый.</i>`, { parse_mode: 'HTML', message_thread_id: newThreadId });
            }
        } catch (finalError) {
            // Если совсем все плохо — в General с ошибкой
            await bot.api.sendMessage(ADMIN_GROUP_ID, `🔥 <b>Фатальная ошибка:</b> Не могу создать топик для клиента.\n${finalError.message}\n\nТекст сообщения:\n${text}`, { parse_mode: 'HTML' });
        }
    }
}

// Пересылка сообщения (Чат с клиентом)
async function copyToGroup(ctx) {
    if (!ADMIN_GROUP_ID) return;
    const user = ctx.from;

    let threadId = await getCachedTopicId(user.id);
    if (!threadId) threadId = await createNewTopic(user);

    try {
        await ctx.copyMessage(ADMIN_GROUP_ID, { message_thread_id: threadId || undefined });
    } catch (e) {
        // Ошибка — пробуем восстановить
        await kv.del(`user:${user.id}`);
        const newThreadId = await createNewTopic(user);
        
        try {
            await ctx.copyMessage(ADMIN_GROUP_ID, { message_thread_id: newThreadId || undefined });
        } catch (finalError) {
            await ctx.copyMessage(ADMIN_GROUP_ID); // В General
        }
    }
}

// ==========================================
// 4. ОБРАБОТЧИКИ
// ==========================================

// Команда START
bot.command('start', async (ctx) => {
    if (ctx.chat.type === 'private') {
        await ctx.reply('👋 Конструктор готов! Нажмите кнопку ниже.\n\n💬 Пишите сюда — менеджер ответит.', { reply_markup: KEYBOARD });
        await sendToGroup(`👋 Пользователь нажал <b>/start</b>`, ctx.from);
    }
});

// Сброс (на всякий случай)
bot.command('reset', async (ctx) => {
    await kv.del(`user:${ctx.from.id}`);
    await ctx.reply('✅');
});

// Заказ (WebApp Data)
bot.on('message:web_app_data', async (ctx) => {
    try {
        const order = JSON.parse(ctx.message.web_app_data.data);
        await sendToGroup(createManagerMessage(order, ctx.from), ctx.from);
        await ctx.reply(createClientMessage(order), { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });
    } catch (e) { console.error(e); }
});

// ПЕРЕПИСКА
bot.on('message', async (ctx, next) => {
    // Игнорируем служебные сообщения и команды
    if (
        ctx.message.is_topic_message || 
        ctx.message.is_automatic_forward || 
        ctx.hasCommand("start") ||
        ctx.hasCommand("reset")
    ) return next();

    const chatId = ctx.chat.id.toString();
    
    // А) КЛИЕНТ ПИШЕТ БОТУ
    if (ctx.chat.type === 'private') {
        await copyToGroup(ctx);
    } 
    // Б) АДМИН ОТВЕЧАЕТ В ГРУППЕ
    else if (chatId === ADMIN_GROUP_ID) {
        const threadId = ctx.message.message_thread_id;
        
        if (threadId) {
            // Ищем юзера
            const userId = await kv.get(`thread:${threadId}`);
            
            if (userId) {
                try {
                    await ctx.copyMessage(userId);
                    // Ставим лайк, чтобы админ понял, что ушло
                    try { await ctx.react('👍'); } catch(e) {}
                } catch (e) {
                    // Если не ушло - пишем в топик
                    console.error(e);
                    await ctx.reply(`❌ Не доставлено: ${e.description}`);
                }
            } else {
                // Если юзер не найден (например старый топик)
                console.log(`[DEBUG] Нет юзера для топика ${threadId}`);
            }
        }
    }
});

const handleUpdate = webhookCallback(bot, 'http');

module.exports = async (req, res) => {
    if (req.method === 'GET') return res.status(200).send('Bot Running');
    
    if (req.body?.type === 'DIRECT_ORDER') {
        const { order, user } = req.body;
        await sendToGroup(createManagerMessage(order, user), user);
        
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