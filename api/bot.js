const { Bot, webhookCallback } = require('grammy');
const { kv } = require('@vercel/kv');

const bot = new Bot(process.env.BOT_TOKEN);
const ADMIN_GROUP_ID = String(process.env.MANAGER_CHAT_ID || '').trim().replace(/['"]/g, ''); 
const webAppUrl = process.env.WEBAPP_URL; 

const KEYBOARD = {
    keyboard: [[{ text: "✅ Открыть конструктор", web_app: { url: webAppUrl } }]],
    resize_keyboard: true
};

// --- 1. ФУНКЦИИ БАЗЫ И ТОПИКОВ (ЯДРО) ---

// Просто создать топик (низкоуровневая функция)
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
        return null;
    }
}

// ГЛАВНАЯ ФУНКЦИЯ: Получить ЖИВОЙ ID топика
// Проверяет существование, если топик мертв - создает новый.
async function getValidTopicId(user) {
    // 1. Читаем кэш
    const cachedId = await kv.get(`user:${user.id}`);
    
    if (cachedId) {
        const threadId = parseInt(cachedId);
        // 2. ПРОВЕРКА: Пытаемся послать "печатает..." в этот топик
        try {
            await bot.api.sendChatAction(ADMIN_GROUP_ID, 'typing', { message_thread_id: threadId });
            return threadId; // Успех! Топик жив.
        } catch (e) {
            console.log(`Топик ${threadId} мертв (удален). Чистим базу...`);
            // Топик удален - чистим мусор
            await kv.del(`user:${user.id}`);
            await kv.del(`thread:${threadId}`);
        }
    }

    // 3. Если кэша нет или топик был мертв - создаем новый
    console.log("Создаем новый топик...");
    return await createNewTopic(user);
}

// --- 2. ФУНКЦИИ ОТПРАВКИ ---

// Универсальная функция доставки
// mode = 'text' (sendMessage) или 'copy' (copyMessage)
async function deliverToAdmin(ctx, mode, content) {
    if (!ADMIN_GROUP_ID) return;
    const user = ctx.from;

    // Получаем ГАРАНТИРОВАННО живой ID (или null, если создать нельзя)
    const threadId = await getValidTopicId(user);

    if (!threadId) {
        // Если создать не вышло - шлем в General с пометкой
        await bot.api.sendMessage(ADMIN_GROUP_ID, `🛑 <b>Ошибка:</b> Не удалось создать тикет для ${user.first_name}`, { parse_mode: 'HTML' });
        if (mode === 'copy') await ctx.copyMessage(ADMIN_GROUP_ID);
        else await bot.api.sendMessage(ADMIN_GROUP_ID, content, { parse_mode: 'HTML' });
        return;
    }

    // Отправляем в топик
    try {
        if (mode === 'copy') {
            await ctx.copyMessage(ADMIN_GROUP_ID, { message_thread_id: threadId });
        } else {
            await bot.api.sendMessage(ADMIN_GROUP_ID, content, { parse_mode: 'HTML', message_thread_id: threadId });
        }
    } catch (e) {
        // Крайний случай (удалили топик за 1мс до отправки)
        await bot.api.sendMessage(ADMIN_GROUP_ID, `🔥 <b>Сбой доставки в топик ${threadId}:</b> ${e.message}`, { parse_mode: 'HTML' });
    }
}

// --- 3. ГЕНЕРАЦИЯ СООБЩЕНИЙ ЗАКАЗА ---

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
// 4. ОБРАБОТЧИКИ
// ==========================================

// Команда START
bot.command('start', async (ctx) => {
    if (ctx.chat.type === 'private') {
        await ctx.reply('👋 Конструктор готов!', { reply_markup: KEYBOARD });
        // Уведомляем админа (используем единую надежную функцию)
        await deliverToAdmin(ctx, 'text', `👋 Пользователь нажал <b>/start</b>`);
    }
});

// Заказ
bot.on('message:web_app_data', async (ctx) => {
    try {
        const order = JSON.parse(ctx.message.web_app_data.data);
        // Шлем админу
        await deliverToAdmin(ctx, 'text', createManagerMessage(order, ctx.from));
        // Ответ клиенту
        await ctx.reply(createClientMessage(order), { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });
    } catch (e) { console.error(e); }
});

// Переписка
bot.on('message', async (ctx, next) => {
    if (ctx.message.is_topic_message || ctx.message.is_automatic_forward) return;

    const chatId = String(ctx.chat.id);

    // А) КЛИЕНТ ПИШЕТ
    if (ctx.chat.type === 'private') {
        // Используем ту же надежную функцию, но в режиме 'copy'
        await deliverToAdmin(ctx, 'copy');
    } 
    
    // Б) АДМИН ОТВЕЧАЕТ (В топике)
    else if (chatId === ADMIN_GROUP_ID) {
        const threadId = ctx.message.message_thread_id;
        if (threadId) {
            const userId = await kv.get(`thread:${threadId}`);
            if (userId) {
                try {
                    await ctx.copyMessage(userId);
                    await ctx.react('👍');
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
    
    if (req.body?.type === 'DIRECT_ORDER') {
        const { order, user } = req.body;
        // Эмулируем контекст для функции
        const fakeCtx = { from: user };
        await deliverToAdmin(fakeCtx, 'text', createManagerMessage(order, user));
        
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