// Подбор категории для строки выписки: правила пользователя → категория банка →
// известные магазины → «Другое». Правила копятся сами из исправлений при импорте.

import type { Rule } from '../db/db';
import { OTHER_CATEGORY_ID } from '../db/seed';

export type CategorySource = 'rule' | 'bank' | 'merchant' | 'none';

// Слова, которые не отличают один магазин от другого. Режем по словам, а не регуляркой
// с \b: в JavaScript \b не видит границ у русских букв.
const NOISE_WORDS = new Set(
  'ооо оао зао пао ип llc ltd inc g г rus russia ru moscow moskva москва msk spb sankt peterburg санкт петербург'.split(' '),
);

/** Ключ магазина: без цифр, знаков, юрформ и городов — «ПЯТЕРОЧКА 1234 MOSCOW RUS» → «пятерочка». */
export function merchantKey(description: string): string {
  return description
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((w) => w && !NOISE_WORDS.has(w))
    .join(' ')
    .slice(0, 40)
    .trim();
}

// Категории из выписки T-Банка и похожих банков → стартовые категории приложения.
const BANK_CATEGORIES: Array<[RegExp, string]> = [
  [/супермаркет|продукт|гипермаркет|магазины у дома/, 'groceries'],
  [/ресторан|кафе|фастфуд|фаст-фуд|кофейн|бары/, 'cafe'],
  [/такси/, 'taxi'],
  [/транспорт|метро|ж\/д|железнодорож|авиабилет|топливо|азс|каршеринг|парков/, 'transport'],
  [/жкх|коммунал|дом и ремонт|ремонт|мебель/, 'home'],
  // «Сервис» у T-Банка — всё подряд (ремонт, химчистка, игры), поэтому его не трогаем
  [/связь|мобильн|интернет|телеком|цифров|подписк/, 'subscriptions'],
  [/аптек|медицин|здоров|красот|клиник/, 'health'],
  [/одежд|обувь/, 'clothes'],
  [/развлеч|кино|книг|музык|игр|театр|спорт|отдых|культур/, 'fun'],
  [/цвет|подар|сувенир/, 'gifts'],
];

// Частые магазины и сервисы — по названию в описании операции.
const MERCHANTS: Array<[RegExp, string]> = [
  [/пятерочк|pyaterochk|перекресток|perekrest|магнит|magnit|вкусвилл|vkusvill|лента|lenta|ашан|auchan|азбука вкуса|дикси|dixy|самокат|samokat|окей|okey|светофор|глобус|верный|чижик|spar|спар/, 'groceries'],
  [/яндекс go|yandex go|yandex taxi|яндекс такси|uber|ситимобил|taxi|такси|максим/, 'taxi'],
  [/метро|metro|mosmetro|метрополитен|тройка|troika|мцд|аэроэкспресс|aeroexpress|ржд|rzd|мосгортранс|transport/, 'transport'],
  [/кофе|coffee|кафе|cafe|starbucks|шоколадниц|kfc|ростикс|burger|бургер|вкусно и точка|макдоналдс|теремок|додо|dodo|пицц|pizza|суши|sushi|ресторан|restaurant|яндекс еда|yandex eda|delivery club|кулинари|столовая|пекарн/, 'cafe'],
  [/аптек|apteka|ригла|горздрав|асна|здравсити|клиник|стоматолог|инвитро|invitro|гемотест/, 'health'],
  // ключ уже без знаков и цифр, слова разделены одним пробелом — границы слова пишем как (^| )…( |$)
  [/(^| )(мтс|mts|ivi|теле|tele)( |$)|билайн|beeline|мегафон|megafon|ростелеком|yandex plus|яндекс плюс|кинопоиск|okko|apple com|itunes|spotify|youtube/, 'subscriptions'],
  [/мосэнерго|энергосбыт|водоканал|управляющ|квартплат|жкх|леруа|leroy|obi|икеа|ikea|hoff/, 'home'],
  [/zara|uniqlo|gloria jeans|befree|ostin|остин|спортмастер|sportmaster|lamoda|ламода|(^| )h m( |$)|снежная королева/, 'clothes'],
  [/кинотеатр|cinema|синема|театр|концерт|steam|playstation|xbox|музей|каро|формула кино/, 'fun'],
  [/цветы|flowers|флорист/, 'gifts'],
];

export interface Suggestion {
  categoryId: string;
  via: CategorySource;
}

/**
 * @param active — id категорий, в которые можно класть (не в архиве); если стартовая
 * категория удалена в архив, подсказка из словаря не применяется.
 */
export function suggestCategory(description: string, bankCategory: string, rules: Rule[], active: Set<string>): Suggestion {
  const key = merchantKey(description);
  const rule = rules
    .filter((r) => r.pattern && key.includes(r.pattern) && active.has(r.categoryId))
    .sort((a, b) => b.pattern.length - a.pattern.length)[0];
  if (rule) return { categoryId: rule.categoryId, via: 'rule' };

  const bank = bankCategory.toLowerCase().replace(/ё/g, 'е');
  const fromBank = bank && BANK_CATEGORIES.find(([re, id]) => re.test(bank) && active.has(id));
  if (fromBank) return { categoryId: fromBank[1], via: 'bank' };

  const fromMerchant = MERCHANTS.find(([re, id]) => re.test(key) && active.has(id));
  if (fromMerchant) return { categoryId: fromMerchant[1], via: 'merchant' };

  return { categoryId: active.has(OTHER_CATEGORY_ID) ? OTHER_CATEGORY_ID : [...active][0], via: 'none' };
}
