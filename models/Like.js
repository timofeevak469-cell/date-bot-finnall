const mongoose = require('mongoose');

const likeSchema = new mongoose.Schema({
  fromUser: { type: Number, required: true },
  toUser: { type: Number, required: true },
  type: { type: String, enum: ['like', 'dislike'], default: 'like' }, // добавили тип
  notified: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

// Индекс для уникальности (пользователь может только один раз лайкнуть/дизлайкнуть другого)
likeSchema.index({ fromUser: 1, toUser: 1 }, { unique: true });

module.exports = mongoose.model('Like', likeSchema);