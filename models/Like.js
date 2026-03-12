const mongoose = require('mongoose');

const likeSchema = new mongoose.Schema({
  fromUser: { type: Number, required: true },
  toUser: { type: Number, required: true },
  createdAt: { type: Date, default: Date.now }
});

// Уникальный индекс, чтобы один пользователь не мог лайкнуть другого дважды
likeSchema.index({ fromUser: 1, toUser: 1 }, { unique: true });

module.exports = mongoose.model('Like', likeSchema);