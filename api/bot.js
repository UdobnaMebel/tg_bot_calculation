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
        console.error("Create Topic Error:", e);
        return null;
    }
}

// --- ГЛАВНАЯ ФУНКЦИЯ ОТПРАВКИ (С ПЕРЕЗАПУСКОМ) ---
// actionCallback - это функция, которая делает отправку (sendMessage или copyMessage)
async function executeWithRetry(user, actionCallback) {
    if (!ADMIN_GROUP_ID) return;

    // 1. Берем ID из кэша
    let threadId = await kv.get(`user:${user.id}`);

    // Если ID есть, пробуем отправить
    if (threadId) {
        try {
            await actionCallback(threadId);
            return; // Успех! Выходим.
        } catch (e) {
            const err = e.description || e.message || '';
            // Если ошибка НЕ связана с удалением топика - пробрасываем её (пусть падает в General)
            // Но если это TOPIC_DELETED или thread not found - чиним.
            const isTopicDead = err.includes('TOPIC_DELETED') || err.includes('thread not found') || err.includes('Bad Request: message thread not found');
            
            if (!isTopicDead) {
                // Если ошибка другая (например, слишком длинный текст), шлем в General
                console.error("Unknown Send Error:", err);
                await actionCallback(null); 
                return;
            }
            
            console.log(`Топик ${threadId} мертв. Чистим и пересоздаем...`);
        }
    }

    // 2. Если мы здесь: либо топика не было, либо он был удален (catch сработал)
    // Чистим старое
    if (threadId) {
        await kv.del(`user:${user.id}`);
        await kv.del(`thread:${threadId}`);
    }

    // Создаем новый
    const newThreadId = await createNewTopic(user);

    // 3. Пробуем отправить в новый
    try {
        if (newThreadId) {
            await actionCallback(newThreadId);
            // Уведомляем о смене
            try { await bot.api.sendMessage(ADMIN_GROUP_ID, "ℹ️ <i>Старый чат был удален. Создан новый.</i>", { parse_mode: 'HTML', message_thread_id: newThreadId }); } catch(e){}
        } else {
            // Если создать не удалось - в General
            await actionCallback(null);
            await bot.api.sendMessage(ADMIN_GROUP_ID, "⚠️ Не удалось создать топик (ошибка прав или лимитов). Сообщение выше в общем чате.");
        }
    } catch (e) {
        // Совсем всё плохо - в General
        await actionCallback(null);
    }
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

// ==========================================
// ОБРАБОТЧИКИ
// ==========================================

// 1. КОМАНДА START
bot.command('start', async (ctx) => {
    if (ctx.chat.type === 'private') {
        await ctx.reply('👋 Конструктор готов!', { reply_markup: KEYBOARD });
        
        // Используем умную функцию для отправки текста
        await executeWithRetry(ctx.from, async (threadId) => {
            await bot.api.sendMessage(ADMIN_GROUP_ID, `👋 Пользователь нажал <b>/start</b>`, { 
                parse_mode: 'HTML', 
                message_thread_id: threadId 
            });
        });
    }
});

// 2. ЗАКАЗ (WebApp Data)
bot.on('message:web_app_data', async (ctx) => {
    try {
        const order = JSON.parse(ctx.message.web_app_data.data);
        const msg = createManagerMessage(order, ctx.from);

        // Умная отправка заказа
        await executeWithRetry(ctx.from, async (threadId) => {
            await bot.api.sendMessage(ADMIN_GROUP_ID, msg, { 
                parse_mode: 'HTML', 
                message_thread_id: threadId 
            });
        });

        await ctx.reply(createClientMessage(order), { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });
    } catch (e) { console.error(e); }
});

// 3. ПЕРЕПИСКА
bot.on('message', async (ctx, next) => {
    if (ctx.message.is_topic_message || ctx.message.is_automatic_forward || ctx.hasCommand("start")) return;

    const chatId = String(ctx.chat.id);
    
    // А) КЛИЕНТ ПИШЕТ (В личку)
    if (ctx.chat.type === 'private') {
        // Умная пересылка (copyMessage)
        await executeWithRetry(ctx.from, async (threadId) => {
            await ctx.copyMessage(ADMIN_GROUP_ID, { message_thread_id: threadId });
        });
    } 
    
    // Б) АДМИН ОТВЕЧАЕТ (В топике)
    else if (chatId === ADMIN_GROUP_ID) {
        const threadId = ctx.message.message_thread_id;
        if (threadId) {
            const userId = await kv.get(`thread:${threadId}`);
            if (userId) {
                try {
                    await ctx.copyMessage(userId);
                    try { await ctx.react('👍'); } catch(e) {}
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
        const msg = createManagerMessage(order, user);
        
        // Умная отправка для прямого заказа
        // Эмулируем user для функции
        await executeWithRetry(user, async (threadId) => {
            await bot.api.sendMessage(ADMIN_GROUP_ID, msg, { 
                parse_mode: 'HTML', 
                message_thread_id: threadId 
            });
        });
        
        if (user.id) {
            try { await bot.api.sendMessage(user.id, createClientMessage(order), { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } }); } catch(e) {}
        }
        return res.status(200).json({ success: true });
    }
    
    try { return await handleUpdate(req, res); } catch (e) { return res.status(500).send('Error'); }
};