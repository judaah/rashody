import type { Category } from './db';

// Первые восемь — проверенная на дальтонизм палитра (blue, orange, aqua, yellow,
// magenta, green, violet, red), дальше — запасные. Серый — для «Другое» и
// «Остальное» на графиках: он сознательно приглушён.
export const OTHER_COLOR = '#8e8e93';

export const CATEGORY_COLORS = [
  '#2a78d6',
  '#eb6834',
  '#1baf7a',
  '#eda100',
  '#e87ba4',
  '#008300',
  '#6250d6',
  '#e34948',
  '#0e8fa8',
  '#a0703c',
  '#64748b',
  OTHER_COLOR,
];

const seed: Array<[id: string, name: string, emoji: string, color: string]> = [
  ['groceries', 'Продукты', '🛒', '#1baf7a'],
  ['cafe', 'Кафе', '☕', '#eb6834'],
  ['transport', 'Транспорт', '🚇', '#2a78d6'],
  ['taxi', 'Такси', '🚕', '#eda100'],
  ['home', 'Дом и ЖКХ', '🏠', '#6250d6'],
  ['subscriptions', 'Связь и подписки', '📱', '#0e8fa8'],
  ['health', 'Здоровье', '💊', '#e34948'],
  ['clothes', 'Одежда', '👕', '#e87ba4'],
  ['fun', 'Развлечения', '🎬', '#008300'],
  ['gifts', 'Подарки', '🎁', '#a0703c'],
  ['other', 'Другое', '📦', OTHER_COLOR],
];

export const OTHER_CATEGORY_ID = 'other';

export const DEFAULT_CATEGORIES: Category[] = seed.map(([id, name, emoji, color], order) => ({
  id,
  name,
  emoji,
  color,
  order,
  archived: false,
}));
