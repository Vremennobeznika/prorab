/**
 * Ошибка, текст которой можно показать человеку как есть.
 * status — код HTTP, с которым сервер ответит странице (400 — «вы что-то указали не так»).
 */
export class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'UserError';
    this.status = status;
  }
}
