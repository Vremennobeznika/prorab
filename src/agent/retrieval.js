// Local lexical retrieval, independently implemented. No embeddings or network calls.
const STOP = new Set('это как для или что все мне мой моя мои про при под над без чтобы нужно надо сделай пожалуйста the and for with this that'.split(' '));
const stem = (s) => s.length > 6 ? s.slice(0, 6) : s;
const normalize = (s) => String(s).toLowerCase().replaceAll('ё', 'е');
const GROUPS = [
  ['ошибка', 'ошибки', 'сбой', 'баг', 'error', 'bug'],
  ['стоимость', 'цена', 'цены', 'price', 'cost'],
  ['изображение', 'рисунок', 'картинка', 'image', 'picture'],
  ['папка', 'каталог', 'folder', 'directory'],
  ['пароль', 'password'], ['отчет', 'отчеты', 'report'],
].map((g) => new Set(g.map(stem)));
export function terms(text) {
  return (normalize(text).match(/[\p{L}\p{N}_]+/gu) || []).filter((s) => s.length > 1 && !STOP.has(s)).map(stem);
}
export function searchRecords(records, query, textOf, limit = 30) {
  const wanted = [...new Set(terms(query))];
  if (!wanted.length) return [];
  const groups = wanted.map((word) => GROUPS.find((g) => g.has(word)) || new Set([word]));
  const docs = records.map((record, order) => {
    const text = String(textOf(record)); const words = terms(text); const counts = new Map();
    for (const word of words) counts.set(word, (counts.get(word) || 0) + 1);
    return { record, order, counts, length: words.length, text };
  });
  const average = docs.reduce((n, d) => n + d.length, 0) / (docs.length || 1) || 1;
  const frequencies = groups.map((group) => docs.filter((d) => [...group].some((w) => d.counts.has(w))).length);
  return docs.map((d) => {
    let score = 0, matches = 0;
    groups.forEach((group, i) => {
      const frequency = [...group].reduce((n, w) => n + (d.counts.get(w) || 0), 0);
      if (!frequency) return;
      matches++;
      const idf = Math.log(1 + (docs.length - frequencies[i] + 0.5) / (frequencies[i] + 0.5));
      score += idf * frequency * 2.2 / (frequency + 1.2 * (0.25 + 0.75 * d.length / average));
    });
    if (normalize(d.text).includes(normalize(query).trim())) score += 2;
    return { ...d, score, coverage: matches / groups.length };
  }).filter((d) => d.coverage >= 0.25).sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, Math.max(0, Math.min(100, limit))).map((d) => d.record);
}
