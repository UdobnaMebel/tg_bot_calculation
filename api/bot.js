const { Bot, webhookCallback } = require('grammy');
const { kv } = require('@vercel/kv');

const bot = new Bot(process.env.BOT_TOKEN);

// 1. ПРИНУДИТЕЛЬНОЕ ПРИВЕДЕНИЕ К СТРОКЕ
const ADMIN_GROUP_ID = String(process.env.MANAGER_CHAT_ID || '').trim().replace(/['"]/g, ''); 
const webAppUrl = process.env.WEBAPP_URL; 

const KEYBOARD = {
    keyboard: [[{ text: "✅ Открыть конструктор", web_app: { url: webAppUrl } }]],
    resize_keyboard: true
};

// --- ДИАГНОСТИКА (НАПИШИ /check В ГРУППЕ) ---
bot.command('check', async (ctx) => {
    const currentId = String(ctx.chat.id);
    const targetId = String(ADMIN_GROUP_ID);
    const match = currentId === targetId;
    
    await ctx.reply(
        `🔍 <b>ДИАГНОСТИКА</b>\n\n` +
        `🆔 Этот чат: <code>${currentId}</code>\n` +
        `⚙️ Настройки: <code>${targetId}</code>\n` +
        `✅ Совпадают? <b>${match ? 'ДА' : 'НЕТ! (Исправь Vercel)'}</b>\n` +
        `💬 Топик: ${ctx.message.message_thread_id || 'Нет (General)'}`,
        { parse_mode: 'HTML' }
    );
});

bot.command('reset', async (ctx) => {
    await kv.del(`user:${ctx.from.id}`);
    await ctx.reply('✅');
});

bot.command('start', async (ctx) => {
    if (ctx.chat.type === 'private') {
        await ctx.reply('👋 Конструктор готов!', { reply_markup: KEYBOARD });
        // При старте тоже запускаем "умную отправку"
        await handleClientMessage(ctx, `👋 Пользователь нажал <b>/start</b>`);
    }
});

// --- ЛОГИКА ТОПИКОВ ---

async function createNewTopic(user) {
    try {
        const randomId = Math.floor(Math.random() * 1000);
        const name = `${user.first_name} ${user.last_name||''} (@${user.username||'no'})`.substring(0, 30);
        const topic = await bot.api.createForumTopic(ADMIN_GROUP_ID, `${name} #${randomId}`);
        
        await kv.set(`user:${user.id}`, topic.message_thread_id);
        await kv.set(`thread:${topic.message_thread_id}`, user.id);
        return topic.message_thread_id;
    } catch (e) {
        console.error("Create error:", e);
        return null;
    }
}

async function getTopicId(user) {
    const cached = await kv.get(`user:${user.id}`);
    if (cached) return parseInt(cached);
    return await createNewTopic(user);
}

// --- УНИВЕРСАЛЬНАЯ ФУНКЦИЯ ОТПРАВКИ/ПЕРЕСЫЛКИ ---
// Она одна обрабатывает и текст, и фото, и заказы
async function handleClientMessage(ctx, textOverride = null) {
    if (!ADMIN_GROUP_ID) return;
    const user = ctx.from;

    // 1. Получаем ID
    let threadId = await getTopicId(user);

    // 2. Функция попытки отправки
    const attemptSend = async (tid) => {
        if (!tid) throw new Error("Не удалось создать топик");
        if (textOverride) {
            await bot.api.sendMessage(ADMIN_GROUP_ID, textOverride, { parse_mode: 'HTML', message_thread_id: tid });
        } else {
            await ctx.copyMessage(ADMIN_GROUP_ID, { message_thread_id: tid });
        }
    };

    try {
        // Попытка 1
        await attemptSend(threadId);
    } catch (e) {
        console.log(`Ошибка отправки в ${threadId}. Пересоздаем...`);
        // Ошибка! Чистим базу
        await kv.del(`user:${user.id}`);
        if (threadId) await kv.del(`thread:${threadId}`);

        // Создаем новый топик
        threadId = await createNewTopic(user);
        
        try {
            // Попытка 2
            await attemptSend(threadId);
            // Уведомляем о смене
            await bot.api.sendMessage(ADMIN_GROUP_ID, `♻️ <i>Старый топик был недоступен. Создан новый.</i>`, { parse_mode: 'HTML', message_thread_id: threadId });
        } catch (e2) {
            // Если совсем всё плохо - шлем в General с логом
            if (textOverride) {
                await bot.api.sendMessage(ADMIN_GROUP_ID, `🔥 <b>FAIL:</b> ${e2.message}\n\n${textOverride}`, { parse_mode: 'HTML' });
            } else {
                await ctx.copyMessage(ADMIN_GROUP_ID); // В General
            }
        }
    }
}

// --- ОБРАБОТЧИКИ ---

// 1. ЗАКАЗ (КНОПКА)
bot.on('message:web_app_data', async (ctx) => {
    const order = JSON.parse(ctx.message.web_app_data.data);
    
    // Формируем текст
    let msg = `🆕 <b>НОВЫЙ ЗАКАЗ</b>\n\n👤 <b>Клиент:</b> @${ctx.from.username||'нет'} (ID: ${ctx.from.id})\n\n📋 <b>Состав:</b>\n`;
    order.items.forEach(i => msg += `${i.name} (${i.color}) - ${i.price}\n`);
    msg += `\n💰 <b>Итого:</b> ${order.total}\n📏 ${order.dims}\n⚖️ ${order.weight.replace('Вес:', '<b>Вес:</b>')}`;

    // Шлем менеджеру (через умную функцию)
    await handleClientMessage(ctx, msg);

    // Шлем клиенту
    let clientMsg = `✅ <b>Заявка принята!</b>\nМенеджер свяжется с вами.\n\n📋 <b>Заказ:</b>\n`;
    order.items.forEach(i => msg += `${i.name} (${i.color})\n`);
    msg += `\n💰 <b>Итого:</b> ${order.total}`;
    await ctx.reply(clientMsg, { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });
});

// 2. ПЕРЕПИСКА
bot.on('message', async (ctx) => {
    // Игнор служебных
    if (ctx.message.is_topic_message || ctx.message.is_automatic_forward) return;

    const currentId = String(ctx.chat.id);
    const targetId = String(ADMIN_GROUP_ID);

    // А) КЛИЕНТ -> АДМИН
    if (ctx.chat.type === 'private') {
        await handleClientMessage(ctx);
    }
    
    // Б) АДМИН -> КЛИЕНТ
    else if (currentId === targetId) {
        
        // --- ДЕБАГ: Если админ пишет /check ---
        // (Этот блок сработает только если ID совпадают)
        if (ctx.message.text === '/check') return; 

        const threadId = ctx.message.message_thread_id;
        
        if (threadId) {
            const userId = await kv.get(`thread:${threadId}`);
            if (userId) {
                try {
                    await ctx.copyMessage(userId);
                    await ctx.react('👍');
                } catch (e) {
                    await ctx.reply(`❌ Не доставлено: ${e.description}`);
                }
            } else {
                // Если ты пишешь в старый топик, которого нет в базе
                await ctx.reply(`⚠️ Этот чат отвязан от клиента (нет в базе).\nПодождите нового сообщения от клиента.`);
            }
        }
    }
});

const handleUpdate = webhookCallback(bot, 'http');

module.exports = async (req, res) => {
    if (req.method === 'GET') return res.status(200).send('Bot Running');
    if (req.body?.type === 'DIRECT_ORDER') {
        // Упрощенная обработка для fetch (только уведомление, без сложной логики топиков, чтобы не усложнять)
        // Если нужно, можно добавить и сюда, но лучше пока тестить основное
        return res.status(200).json({ success: true });
    }
    try { return await handleUpdate(req, res); } catch (e) { return res.status(500).send('Error'); }
};