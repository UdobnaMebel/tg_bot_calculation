const { Bot, webhookCallback } = require('grammy');
const { kv } = require('@vercel/kv');

const bot = new Bot(process.env.BOT_TOKEN);
// Чистим ID группы от кавычек и пробелов
const ADMIN_GROUP_ID = String(process.env.MANAGER_CHAT_ID || '').trim().replace(/['"]/g, ''); 
const webAppUrl = process.env.WEBAPP_URL; 

const KEYBOARD = {
    keyboard: [[{ text: "✅ Открыть конструктор", web_app: { url: webAppUrl } }]],
    resize_keyboard: true
};

// --- БАЗОВЫЕ ФУНКЦИИ (БЕЗ МАГИИ) ---

// 1. Создать топик и запомнить
async function createTopic(user) {
    try {
        const name = `${user.first_name} ${user.last_name||''} (@${user.username||'no'})`.substring(0, 60);
        // Добавляем рандом, чтобы телеграм не ругался на дубли названий
        const topic = await bot.api.createForumTopic(ADMIN_GROUP_ID, `${name} [${Math.floor(Math.random() * 100)}]`);
        
        await kv.set(`user:${user.id}`, topic.message_thread_id);
        await kv.set(`thread:${topic.message_thread_id}`, user.id);
        
        return topic.message_thread_id;
    } catch (e) {
        console.error("Ошибка создания топика:", e);
        return null;
    }
}

// 2. Получить ID топика (или создать новый, если старого нет)
async function getTopicId(user) {
    const cached = await kv.get(`user:${user.id}`);
    if (cached) return parseInt(cached);
    return await createTopic(user);
}

// 3. Отправка в группу с ОДНОЙ попыткой восстановления
// Если топик удален, функция сама создаст новый и отправит туда
async function forwardToAdmin(ctx, isOrder = false, orderText = null) {
    const user = ctx.from;
    let threadId = await getTopicId(user);

    try {
        if (isOrder) {
            await bot.api.sendMessage(ADMIN_GROUP_ID, orderText, { parse_mode: 'HTML', message_thread_id: threadId });
        } else {
            await ctx.copyMessage(ADMIN_GROUP_ID, { message_thread_id: threadId });
        }
    } catch (e) {
        // Если ошибка (например, топик удален) - удаляем из базы и пробуем еще 1 раз
        console.log("Ошибка отправки, пробую пересоздать топик...");
        await kv.del(`user:${user.id}`);
        threadId = await createTopic(user); // Создаем новый
        
        // Попытка №2
        if (threadId) {
            if (isOrder) {
                await bot.api.sendMessage(ADMIN_GROUP_ID, orderText, { parse_mode: 'HTML', message_thread_id: threadId });
            } else {
                await ctx.copyMessage(ADMIN_GROUP_ID, { message_thread_id: threadId });
            }
        } else {
            // Если совсем не вышло - в General
            if (isOrder) await bot.api.sendMessage(ADMIN_GROUP_ID, orderText, { parse_mode: 'HTML' });
            else await ctx.copyMessage(ADMIN_GROUP_ID);
        }
    }
}

// --- ФОРМАТИРОВАНИЕ ЗАКАЗА ---

function formatOrder(order, user) {
    let msg = `🆕 <b>НОВЫЙ ЗАКАЗ</b>\n\n👤 <b>Клиент:</b> @${user.username||'нет'} (ID: ${user.id})\n\n📋 <b>Состав:</b>\n`;
    order.items.forEach(i => msg += `${i.name} (${i.color})\n   └ ${i.price ? i.price.toLocaleString() + ' ₽' : 'Вкл'}\n`);
    msg += `\n💰 <b>Итого:</b> ${order.total}\n📏 ${order.dims}\n⚖️ ${order.weight.replace('Вес:', '<b>Вес:</b>')}`;
    return msg;
}

function formatClientReceipt(order) {
    let msg = `✅ <b>Ваша заявка принята!</b>\nМенеджер скоро свяжется с вами.\n\n📋 <b>Заказ:</b>\n`;
    order.items.forEach(i => msg += `${i.name} (${i.color})\n`);
    msg += `\n💰 <b>Итого:</b> ${order.total}`;
    return msg;
}

// ==========================================
// ЛОГИКА БОТА
// ==========================================

// 1. КОМАНДА START
bot.command('start', async (ctx) => {
    if (ctx.chat.type === 'private') {
        await ctx.reply('👋 Конструктор готов!', { reply_markup: KEYBOARD });
        // Уведомляем админа = создаем топик
        await forwardToAdmin(ctx, true, `👋 Пользователь ${ctx.from.first_name} нажал <b>/start</b>`);
    }
});

// 2. ПОЛУЧЕНИЕ ЗАКАЗА (WebApp)
bot.on('message:web_app_data', async (ctx) => {
    try {
        const order = JSON.parse(ctx.message.web_app_data.data);
        
        // Шлем админу (создаст топик сам)
        await forwardToAdmin(ctx, true, formatOrder(order, ctx.from));
        
        // Шлем клиенту
        await ctx.reply(formatClientReceipt(order), { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });
    } catch (e) { console.error(e); }
});

// 3. ПЕРЕПИСКА
bot.on('message', async (ctx) => {
    // Игнорируем служебные обновления (редактирование, пины и т.д.)
    if (ctx.message.is_topic_message || ctx.message.is_automatic_forward) return;

    const chatId = String(ctx.chat.id);

    // СЦЕНАРИЙ А: Клиент пишет боту (ЛС)
    if (ctx.chat.type === 'private') {
        await forwardToAdmin(ctx);
    } 
    
    // СЦЕНАРИЙ Б: Админ пишет в группе (Топик)
    else if (chatId === ADMIN_GROUP_ID) {
        const threadId = ctx.message.message_thread_id;
        if (!threadId) return; // Пишут в General - игнор

        const userId = await kv.get(`thread:${threadId}`);
        if (userId) {
            try {
                await ctx.copyMessage(userId);
                await ctx.react('👍'); // Подтверждение доставки
            } catch (e) {
                console.error("Ошибка ответа клиенту:", e);
                // Можно добавить реакцию 👎
            }
        }
    }
});

// ЗАПУСК
const handleUpdate = webhookCallback(bot, 'http');

module.exports = async (req, res) => {
    if (req.method === 'GET') return res.status(200).send('Bot Running');
    
    // Поддержка fetch запроса (на всякий случай)
    if (req.body?.type === 'DIRECT_ORDER') {
        const { order, user } = req.body;
        // Эмулируем контекст для простой функции
        const fakeCtx = { from: user, copyMessage: () => {} }; 
        await forwardToAdmin(fakeCtx, true, formatOrder(order, user));
        
        if (user.id) {
            try { await bot.api.sendMessage(user.id, formatClientReceipt(order), { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } }); } catch(e) {}
        }
        return res.status(200).json({ success: true });
    }
    
    try { return await handleUpdate(req, res); } catch (e) { return res.status(500).send('Error'); }
};