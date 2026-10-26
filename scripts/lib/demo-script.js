// Сценарий демо-модели: прочитать папку, прочитать привет.txt, дописать строку (с вашего разрешения).
// Так можно увидеть весь путь агента — от задачи до разрешения на телефоне — без настоящей модели.
export function demoScript(messages) {
  const results = messages.filter((m) => m.role === 'tool');

  if (results.length === 0) {
    return { content: 'Сначала посмотрю, какие файлы есть в рабочей папке.', toolCall: { name: 'list_files', args: { path: '.' } } };
  }
  if (results.length === 1) {
    return { content: 'Теперь прочитаю файл привет.txt.', toolCall: { name: 'read_file', args: { path: 'привет.txt' } } };
  }
  if (results.length === 2) {
    const original = results[1].content.startsWith('Ошибка') ? '' : `${results[1].content.trimEnd()}\n`;
    return {
      content: 'Допишу в конец файла одну строку. Для этого нужно ваше разрешение.',
      toolCall: { name: 'write_file', args: { path: 'привет.txt', content: `${original}Эту строку дописал демонстрационный агент.\n` } },
    };
  }
  if (results[2].content.startsWith('Человек отклонил')) {
    return { content: 'Вы отклонили запись, поэтому файл остался прежним. Так и работает контроль: без вашего «да» ничего не меняется.' };
  }
  return { content: 'Готово: прочитал привет.txt и дописал в конец одну строку. Это демонстрация — настоящая модель отвечала бы по вашей задаче.' };
}
