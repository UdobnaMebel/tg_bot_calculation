// api/bot.js
const { Bot, webhookCallback } = require('grammy');

const bot = new Bot(process.env.BOT_TOKEN);
const MANAGER_CHAT_ID = process.env.MANAGER_CHAT_ID; 

// Клавиатура вынесена в отдельную переменную, чтобы использовать её везде
const KEYBOARD = {
    keyboard: [
        [{ 
            text: "🛏 Открыть конструктор", 
            web_app: { url: process.env.WEBAPP_URL } 
        }]
    ],
    resize_keyboard: true
};

bot.command('start', async (ctx) => {
    await ctx.reply('👋 Добро пожаловать в конструктор мебели!\n\nНажмите кнопку ниже, чтобы собрать свой комплект.', {
        reply_markup: KEYBOARD
    });
});

bot.on('message:web_app_data', async (ctx) => {
    const { data } = ctx.message.web_app_data;
    
    try {
        const order = JSON.parse(data);
        
        let message = `🆕 <b>НОВЫЙ ЗАКАЗ</b>\n\n`;
        message += `👤 <b>Клиент:</b> @${ctx.from.username || 'Нет ника'} (${ctx.from.first_name})\n`;
        message += `💰 <b>Итого:</b> ${order.total}\n`;
        message += `📏 <b>Габариты:</b> ${order.dims}\n`;
        message += `⚖️ <b>Вес:</b> ${order.weight}\n\n`;
        message += `📋 <b>Состав заказа:</b>\n`;

        order.items.forEach((item, index) => {
            message += `\n<b>${index + 1}. ${item.name}</b>\n`;
            message += `   └ 🎨 ${item.color}\n`;
            message += `   └ 💵 ${item.price ? item.price.toLocaleString() + ' ₽' : 'Включено'}\n`;
        });

        // Отправка менеджеру
        if (MANAGER_CHAT_ID) {
            try {
                await ctx.api.sendMessage(MANAGER_CHAT_ID, message, { parse_mode: 'HTML' });
            } catch (err) {
                console.error("Ошибка отправки менеджеру:", err);
            }
        }

        // Ответ клиенту (С СОХРАНЕНИЕМ КНОПКИ)
        await ctx.reply(`✅ <b>Заявка принята!</b>\n\nМенеджер скоро свяжется с вами.\n\nВаш заказ:\n${order.items.map(i => `• ${i.name}`).join('\n')}`, {
            parse_mode: 'HTML',
            reply_markup: KEYBOARD // <--- Возвращаем кнопку клиенту
        });

    } catch (e) {
        console.error(e);
        await ctx.reply('Произошла ошибка при обработке данных. Попробуйте снова.', {
            reply_markup: KEYBOARD
        });
    }
});

module.exports = webhookCallback(bot, 'http');