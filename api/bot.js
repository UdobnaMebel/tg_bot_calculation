const { Bot, webhookCallback } = require('grammy');
const Redis = require('ioredis');

const bot = new Bot(process.env.BOT_TOKEN);

// Очищаем ID от пробелов, кавычек и всего лишнего
const ENV_GROUP_ID = (process.env.MANAGER_CHAT_ID || '').trim().replace(/['"]/g, ''); 
const webAppUrl = process.env.WEBAPP_URL; 

const redis = new Redis(process.env.REDIS_URL); 
redis.on('error', (err) => console.error('Redis Client Error', err));

const KEYBOARD = {
    keyboard: [[{ text: "✅ Открыть конструктор", web_app: { url: webAppUrl } }]],
    resize_keyboard: true
};

// --- ФУНКЦИИ ---

async function getOrCreateTopic(user) {
    const userId = user.id;
    const existingThreadId = await redis.get(`user:${userId}`);
    if (existingThreadId) return parseInt(existingThreadId);

    try {
        const topicName = `${user.first_name} ${user.last_name || ''} (@${user.username || 'anon'})`.trim().substring(0, 60);
        const topic = await bot.api.createForumTopic(ENV_GROUP_ID, topicName);
        await redis.set(`user:${userId}`, topic.message_thread_id);
        await redis.set(`thread:${topic.message_thread_id}`, userId);
        return topic.message_thread_id;
    } catch (e) {
        return null;
    }
}

// ... Функции создания сообщений (оставим сокращенными для краткости, они работают) ...
function createClientMessage(orderData) { return `✅ Заказ принят! Сумма: ${orderData.total}`; }
function createManagerMessage(orderData, user) { return `🆕 ЗАКАЗ от ${user.first_name}\nID: ${user.id}\nСумма: ${orderData.total}`; }

// Отправка
async function sendOrderToManager(orderData, userData) {
    const message = createManagerMessage(orderData, userData);
    if (ENV_GROUP_ID) {
        const threadId = await getOrCreateTopic(userData);
        await bot.api.sendMessage(ENV_GROUP_ID, message, { message_thread_id: threadId || undefined });
    }
}
async function sendConfirmationToClient(orderData, userData) {
    if (userData?.id) await bot.api.sendMessage(userData.id, createClientMessage(orderData), { reply_markup: { remove_keyboard: true } });
}

// === ГЛАВНЫЙ ОТЛАДОЧНЫЙ ОБРАБОТЧИК ===

bot.on('message', async (ctx, next) => {
    if (ctx.message.web_app_data || ctx.message.is_automatic_forward) return next();

    const currentChatId = String(ctx.chat.id); // ID текущего чата
    const targetGroupId = String(ENV_GROUP_ID); // ID из настроек Vercel
    const threadId = ctx.message.message_thread_id;

    // 1. ПРОВЕРКА: Бот видит сообщение в группе?
    // Если ID чата совпадает с ID группы (даже если это топик)
    if (currentChatId === targetGroupId) {
        
        // --- БЛОК ОТЛАДКИ (БОТ ОТВЕТИТ ТЕБЕ В ЧАТЕ) ---
        // Если бот ответит на это сообщение, значит он его ВИДИТ.
        // Если не ответит - значит Group Privacy всё еще включен или бот не админ.
        if (ctx.message.text === '/ping') {
             await ctx.reply(`🏓 PONG!\n\nChat ID: ${currentChatId}\nTarget ID: ${targetGroupId}\nThread ID: ${threadId}\nRedis Key: thread:${threadId}`);
             return;
        }
        // ---------------------------------------------

        if (threadId) {
            const userId = await redis.get(`thread:${threadId}`);
            
            if (userId) {
                try {
                    await ctx.copyMessage(userId);
                    // Ставим реакцию, чтобы ты видел, что ушло
                    await ctx.react('👍');
                } catch (e) {
                    await ctx.reply(`❌ Ошибка отправки: ${e.message}`);
                }
            } else {
                // Если бот не нашел юзера в базе, он скажет об этом
                await ctx.reply(`⚠️ Я не знаю, чей это топик.\nВ базе нет записи для thread:${threadId}.\nПопробуйте сделать новый заказ.`);
            }
        } else {
            // Сообщение в General
        }
    } 
    
    // 2. Клиент пишет боту
    else if (ctx.chat.type === 'private') {
        const tId = await getOrCreateTopic(ctx.from);
        if (ENV_GROUP_ID && tId) {
            await ctx.copyMessage(ENV_GROUP_ID, { message_thread_id: tId });
        }
    }
    
    return next();
});

// Заказы и Запуск
bot.on('message:web_app_data', async (ctx) => {
    const { data } = ctx.message.web_app_data;
    const order = JSON.parse(data);
    await sendOrderToManager(order, ctx.from);
    await ctx.reply(createClientMessage(order), { reply_markup: { remove_keyboard: true } });
});

const handleUpdate = webhookCallback(bot, 'http');
module.exports = async (req, res) => {
    if (req.method === 'GET') return res.status(200).send('Bot Running');
    if (req.body?.type === 'DIRECT_ORDER') {
        await sendOrderToManager(req.body.order, req.body.user);
        await sendConfirmationToClient(req.body.order, req.body.user);
        return res.status(200).json({ success: true });
    }
    return await handleUpdate(req, res);
};