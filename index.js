// Подключаем библиотеки
require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');

// Подключаем наши модели
const User = require('./models/User');
const Like = require('./models/Like');
const Match = require('./models/Match');

// Создаём бота с токеном из .env
const bot = new Telegraf(process.env.BOT_TOKEN);

// Подключаем сессии (хранятся в файле sessions.json)
bot.use(new LocalSession({ database: 'sessions.json' }).middleware());

// Подключаемся к базе данных MongoDB
mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('✅ База данных подключена');
    User.updateMany({ active: { $exists: false } }, { $set: { active: true } })
      .then(result => console.log(`✅ Обновлено ${result.modifiedCount} пользователей: добавлено active=true`))
      .catch(err => console.error('❌ Ошибка при обновлении active:', err));
  })
  .catch(err => console.error('❌ Ошибка подключения к БД:', err));

// Вспомогательные функции
async function getUser(telegramId) {
  return await User.findOne({ telegramId });
}

async function createUser(telegramId, data) {
  const user = new User({ telegramId, ...data, active: true });
  return await user.save();
}

async function updateUserField(telegramId, field, value) {
  const update = {};
  update[field] = value;
  update.updatedAt = Date.now();
  return await User.findOneAndUpdate({ telegramId }, update, { new: true });
}

// Показать свою анкету
async function showMyProfile(ctx, user) {
  const caption = `${user.name}, ${user.age}\n\n${user.description}`;
  await ctx.replyWithPhoto(user.photoFileId, { caption });
}

// Показать следующую анкету
async function showNextProfile(ctx, currentUserId) {
  const currentUser = await getUser(currentUserId);
  if (!currentUser) {
    await ctx.reply('Сначала создай анкету через /start');
    return;
  }

  const filter = {
    telegramId: { $ne: currentUserId },
    gender: currentUser.lookingFor === 'all'
      ? { $in: ['male', 'female', 'other'] }
      : currentUser.lookingFor,
    active: true
  };

  const likedUsers = await Like.find({ fromUser: currentUserId }).select('toUser');
  const likedIds = likedUsers.map(l => l.toUser);
  filter.telegramId = { $nin: [currentUserId, ...likedIds] };

  const candidate = await User.findOne(filter);
  if (!candidate) {
    await ctx.reply('😕 Больше нет анкет для показа. Загляни позже!');
    return;
  }

  ctx.session = { viewing: candidate.telegramId };

  const caption = `${candidate.name}, ${candidate.age}\n\n${candidate.description}`;
  await ctx.replyWithPhoto(candidate.photoFileId, {
    caption,
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback('❤️', 'like'),
        Markup.button.callback('👎', 'dislike'),
        Markup.button.callback('🔙', 'back')
      ]
    ])
  });
}

// Показать следующего лайкнувшего (если используется)
async function showNextLiker(ctx, userId) {
  const like = await Like.findOne({ toUser: userId, notified: false }).sort({ createdAt: 1 });
  if (!like) {
    await ctx.reply('Больше нет анкет для просмотра.');
    return;
  }

  const liker = await User.findOne({ telegramId: like.fromUser });
  if (!liker) {
    await Like.deleteOne({ _id: like._id });
    return showNextLiker(ctx, userId);
  }

  ctx.session = { viewingLiker: like._id.toString() };
  const caption = ` ${liker.name}, ${liker.age}\n\n${liker.description}`;
  await ctx.replyWithPhoto(liker.photoFileId, {
    caption,
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback('❤️', 'like_liker'),
        Markup.button.callback('👎', 'dislike_liker'),
        Markup.button.callback('🔙', 'back_liker')
      ]
    ])
  });
}

// Главное меню
function mainMenu(user) {
  if (!user) {
    return Markup.keyboard([['📝 Создать анкету']]).resize();
  }
  if (user.active) {
    return Markup.keyboard([
      ['👀 Смотреть анкеты', '📝 Моя анкета'],
      ['✏️ Редактировать анкету']
    ]).resize();
  } else {
    return Markup.keyboard([
      ['▶️ Начать поиск', '📝 Моя анкета'],
      ['✏️ Редактировать анкету']
    ]).resize();
  }
}

// Команда /start
bot.start(async (ctx) => {
  const userId = ctx.from.id;
  const user = await getUser(userId);
  if (!user) {
    ctx.session = { step: 'name' };
    await ctx.reply('Привет! Давай найдем тебе сладкую омежку?).\nКак тебя зовут?');
  } else {
    await ctx.reply('Ты уже зарегистрирован. Что хочешь сделать?',
      Markup.inlineKeyboard([
        [Markup.button.callback('📝 Создать новую анкету', 'start_new')],
        [Markup.button.callback('✅ Продолжить со старой', 'start_old')]
      ]));
  }
});

// Обработка текста
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text;

  if (ctx.session && ctx.session.step) {
    await handleRegistration(ctx, userId, text);
    return;
  }
  if (ctx.session && ctx.session.editStep === 'editDescription') {
    await handleEdit(ctx, userId, text);
    return;
  }
  await handleMenu(ctx, userId, text);
});

// Регистрация
async function handleRegistration(ctx, userId, text) {
  const step = ctx.session.step;
  try {
    switch (step) {
      case 'name':
        ctx.session.name = text;
        ctx.session.step = 'age';
        await ctx.reply('Сколько тебе лет?');
        break;
      case 'age':
        const age = parseInt(text);
        if (isNaN(age) || age < 0 || age > 100) {
          await ctx.reply('Пожалуйста, введи корректный возраст (число от 0 до 100).');
          return;
        }
        ctx.session.age = age;
        ctx.session.step = 'gender';
        await ctx.reply('Твой пол?', Markup.keyboard([
          ['Я парень', 'Я девушка']
            ]).oneTime().resize());
        break;
      case 'gender':
        let gender = '';
        if (text === 'Я парень') gender = 'male';
        else if (text === 'Я девушка') gender = 'female';
        else gender = 'other';
        ctx.session.gender = gender;
        ctx.session.step = 'lookingFor';
        await ctx.reply('Кого будем искать?', Markup.keyboard([
          ['Парни', 'Девушки', 'Все равно']
        ]).oneTime().resize());
        break;
      case 'lookingFor':
        let lookingFor = '';
        if (text === 'Парни') lookingFor = 'male';
        else if (text === 'Девушки') lookingFor = 'female';
        else lookingFor = 'all';
        ctx.session.lookingFor = lookingFor;
        ctx.session.step = 'description';
        await ctx.reply('Напиши немного о себе (С каким запахом омежку будем искать?)).');
        break;
      case 'description':
        ctx.session.description = text;
        ctx.session.step = 'photo';
        await ctx.reply('Отправь своё фото.');
        break;
      default:
        ctx.session = null;
        await ctx.reply('Что-то пошло не так. Начни заново /start');
    }
  } catch (error) {
    console.error(error);
    await ctx.reply('Произошла ошибка. Попробуй позже.');
    ctx.session = null;
  }
}

// Обработка фото
bot.on('photo', async (ctx) => {
  const userId = ctx.from.id;
  const photos = ctx.message.photo;
  const fileId = photos[photos.length - 1].file_id;

  if (ctx.session && ctx.session.editStep === 'editPhoto') {
    try {
      await updateUserField(userId, 'photoFileId', fileId);
      ctx.session = null;
      const user = await getUser(userId);
      await ctx.reply('✅ Фото обновлено!', mainMenu(user));
    } catch (error) {
      console.error(error);
      await ctx.reply('Ошибка при обновлении фото.');
      ctx.session = null;
    }
    return;
  }
  if (ctx.session && ctx.session.step === 'photo') {
    try {
      const userData = {
        firstName: ctx.from.first_name,
        username: ctx.from.username,
        name: ctx.session.name,
        age: ctx.session.age,
        gender: ctx.session.gender,
        lookingFor: ctx.session.lookingFor,
        description: ctx.session.description,
        photoFileId: fileId,
        active: true
      };
      const newUser = await createUser(userId, userData);
      ctx.session = null;

      await showMyProfile(ctx, newUser);
      await ctx.reply('Всё верно?\n1. Да\n2. Редактировать',
        Markup.inlineKeyboard([
          [Markup.button.callback('1', 'confirm_ok')],
          [Markup.button.callback('2', 'confirm_edit')]
        ]));
    } catch (error) {
      console.error(error);
      await ctx.reply('Ошибка при сохранении анкеты. Попробуй ещё раз /start');
      ctx.session = null;
    }
    return;
  }

  await ctx.reply('Сейчас не нужно фото. Используй меню.');
});

// Обработчики инлайн-кнопок
bot.action('start_new', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
  const userId = ctx.from.id;
  await User.deleteOne({ telegramId: userId });
  await Like.deleteMany({ $or: [{ fromUser: userId }, { toUser: userId }] });
  await Match.deleteMany({ users: userId });
  ctx.session = { step: 'name' };
  await ctx.reply('Давай создадим новую анкету.\nКак тебя зовут?');
});

bot.action('start_old', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
  const userId = ctx.from.id;
  const user = await getUser(userId);
  await ctx.reply('С возвращением!', mainMenu(user));
});

bot.action('confirm_ok', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
  const user = await getUser(ctx.from.id);
  await ctx.reply('Отлично!', mainMenu(user));
});

bot.action('confirm_edit', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
  await ctx.reply('Выбери действие:\n1. Изменить фото\n2. Изменить описание\n3. Заполнить анкету заново\n4. Отмена',
    Markup.inlineKeyboard([
      [Markup.button.callback('1', 'edit_photo')],
      [Markup.button.callback('2', 'edit_description')],
      [Markup.button.callback('3', 'edit_restart')],
      [Markup.button.callback('4', 'edit_cancel')]
    ]));
});

bot.action('edit_photo', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
  ctx.session = { editStep: 'editPhoto' };
  await ctx.reply('Отправь новое фото.');
});

bot.action('edit_description', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
  ctx.session = { editStep: 'editDescription' };
  await ctx.reply('Напиши новое описание.');
});

bot.action('edit_restart', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
  const userId = ctx.from.id;
  await User.deleteOne({ telegramId: userId });
  ctx.session = { step: 'name' };
  await ctx.reply('Давай создадим анкету заново.\nКак тебя зовут?');
});

bot.action('edit_cancel', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
  ctx.session = null;
  const user = await getUser(ctx.from.id);
  await ctx.reply('Редактирование отменено.', mainMenu(user));
});

bot.action('like', async (ctx) => {
  await ctx.answerCbQuery();
  const fromUserId = ctx.from.id;
  const toUserId = ctx.session?.viewing;
  if (!toUserId) {
    await ctx.reply('Ошибка: не выбран пользователь.');
    return;
  }
  try {
    await Like.create({ fromUser: fromUserId, toUser: toUserId });
    const mutual = await Like.findOne({ fromUser: toUserId, toUser: fromUserId });
    if (mutual) {
      await Match.create({ users: [fromUserId, toUserId] });
      await ctx.telegram.sendMessage(fromUserId, '🎉 Взаимная симпатия!');
      await ctx.telegram.sendMessage(toUserId, '🎉 Взаимная симпатия!');
      } else {
      await ctx.reply('❤️ Лайк отправлен!');
    }
    await showNextProfile(ctx, fromUserId);
  } catch (error) {
    if (error.code === 11000) {
      await ctx.reply('Вы уже лайкали этого пользователя.');
      await showNextProfile(ctx, fromUserId);
    } else {
      console.error(error);
      await ctx.reply('Ошибка при отправке лайка.');
    }
  }
});

bot.action('dislike', async (ctx) => {
  await ctx.answerCbQuery();
  const fromUserId = ctx.from.id;
  await ctx.reply('👎 Пропускаем...');
  await showNextProfile(ctx, fromUserId);
});

bot.action('back', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
  const userId = ctx.from.id;
  await ctx.reply('Выбери действие:\n1. Моя анкета\n2. Продолжить\n3. Не искать',
    Markup.inlineKeyboard([
      [Markup.button.callback('1', 'back_myprofile')],
      [Markup.button.callback('2', 'back_continue')],
      [Markup.button.callback('3', 'back_deactivate')]
    ]));
});

bot.action('back_myprofile', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
  const userId = ctx.from.id;
  const user = await getUser(userId);
  await showMyProfile(ctx, user);
  await ctx.reply('Что хочешь сделать?\n1. Изменить фото\n2. Изменить описание\n3. Заполнить анкету заново\n4. Вернуться в меню',
    Markup.inlineKeyboard([
      [Markup.button.callback('1', 'edit_photo')],
      [Markup.button.callback('2', 'edit_description')],
      [Markup.button.callback('3', 'edit_restart')],
      [Markup.button.callback('4', 'back_to_menu')]
    ]));
});

bot.action('back_continue', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
  const userId = ctx.from.id;
  await showNextProfile(ctx, userId);
});

bot.action('back_deactivate', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
  const userId = ctx.from.id;
  await updateUserField(userId, 'active', false);
  const user = await getUser(userId);
  await ctx.reply('Твоя анкета скрыта. Чтобы снова начать поиск, нажми "▶️ Начать поиск" в меню.', mainMenu(user));
});

bot.action('back_to_menu', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
  const userId = ctx.from.id;
  const user = await getUser(userId);
  await ctx.reply('Главное меню:', mainMenu(user));
});

// Обработка редактирования описания
async function handleEdit(ctx, userId, text) {
  try {
    await updateUserField(userId, 'description', text);
    ctx.session = null;
    const user = await getUser(userId);
    await ctx.reply('✅ Описание обновлено!', mainMenu(user));
  } catch (error) {
    console.error(error);
    await ctx.reply('Ошибка при обновлении описания.');
    ctx.session = null;
  }
}

// Обработка меню
async function handleMenu(ctx, userId, text) {
  const user = await getUser(userId);
  if (!user) {
    if (text === '📝 Создать анкету') {
      ctx.session = { step: 'name' };
      await ctx.reply('Как тебя зовут?');
    } else {
      await ctx.reply('Нажми /start, чтобы начать.');
    }
    return;
  }

  if (text === '👀 Смотреть анкеты' || text === '▶️ Начать поиск') {
    if (text === '▶️ Начать поиск') {
      await updateUserField(userId, 'active', true);
    }
    await showNextProfile(ctx, userId);
  } else if (text === '📝 Моя анкета') {
    await showMyProfile(ctx, user);
    await ctx.reply('Что хочешь сделать?\n1. Изменить фото\n2. Изменить описание\n3. Заполнить анкету заново\n4. Вернуться в меню',
      Markup.inlineKeyboard([
        [Markup.button.callback('1', 'edit_photo')],
        [Markup.button.callback('2', 'edit_description')],
        [Markup.button.callback('3', 'edit_restart')],
        [Markup.button.callback('4', 'back_to_menu')]
      ]));
  } else if (text === '✏️ Редактировать анкету') {
    await ctx.reply('Выбери действие:\n1. Изменить фото\n2. Изменить описание\n3. Заполнить анкету заново\n4. Отмена',
      Markup.inlineKeyboard([
        [Markup.button.callback('1', 'edit_photo')],
        [Markup.button.callback('2', 'edit_description')],
        [Markup.button.callback('3', 'edit_restart')],
        [Markup.button.callback('4', 'edit_cancel')]
      ]));
  } else {
    await ctx.reply('Не понял команду. Используй кнопки меню.');
  }
}

// Запуск бота
bot.launch();
console.log('🤖 Бот запущен...');

// Корректное завершение
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));