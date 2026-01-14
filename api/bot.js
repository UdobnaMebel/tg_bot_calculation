// api/bot.js
const { Bot, webhookCallback } = require('grammy');

// Токен берем из переменных окружения (настроим в Vercel)
const bot = new Bot(process.env.BOT_TOKEN);

// ID чата менеджера, куда будут падать заявки (тоже в переменные)
const MANAGER_CHAT_ID = process.env.MANAGER_CHAT_ID; 

// Команда /start
bot.command('start', async (ctx) => {
    await ctx.reply('👋 Добро пожаловать в конструктор мебели!\n\nНажмите кнопку ниже, чтобы собрать свой комплект.', {
        reply_markup: {
            keyboard: [
                [{ 
                    text: "🛏 Открыть конструктор", 
                    web_app: { url: process.env.WEBAPP_URL } // Ссылка на твой Vercel
                }]
            ],
            resize_keyboard: true
        }
    });
});

// Обработка данных из WebApp
bot.on('message:web_app_data', async (ctx) => {
    const { data } = ctx.message.web_app_data;
    
    try {
        const order = JSON.parse(data); // Превращаем строку обратно в объект
        
        // Формируем красивое сообщение
        let message = `🆕 <b>НОВЫЙ ЗАКАЗ</b>\n\n`;
        message += `👤 <b>Клиент:</b> @${ctx.from.username || 'Без юзернейма'} (${ctx.from.first_name})\n`;
        message += `💰 <b>Итого:</b> ${order.total}\n`;
        message += `📏 <b>Габариты:</b> ${order.dims}\n`;
        message += `⚖️ <b>Вес:</b> ${order.weight}\n\n`;
        message += `📋 <b>Состав заказа:</b>\n`;

        order.items.forEach((item, index) => {
            message += `\n<b>${index + 1}. ${item.name}</b>\n`;
            message += `   └ 🎨 ${item.color}\n`;
            message += `   └ 💵 ${item.price.toLocaleString()} ₽\n`;
        });

        // 1. Отправляем отчет МЕНЕДЖЕРУ
        if (MANAGER_CHAT_ID) {
            await ctx.api.sendMessage(MANAGER_CHAT_ID, message, { parse_mode: 'HTML' });
        }

        // 2. Отправляем подтверждение КЛИЕНТУ
        await ctx.reply(`✅ <b>Заявка принята!</b>\n\nМенеджер скоро свяжется с вами для уточнения деталей.\n\nВаш заказ:\n${order.items.map(i => `• ${i.name}`).join('\n')}`, {
            parse_mode: 'HTML',
            reply_markup: { remove_keyboard: true } // Убираем кнопку WebApp
        });

    } catch (e) {
        console.error(e);
        await ctx.reply('Произошла ошибка при обработке данных.');
    }
});

// Экспортируем обработчик для Vercel (Webhook)
module.exports = webhookCallback(bot, 'http');