// Светлая / тёмная тема. Подключается в <head> до отрисовки страницы, чтобы не было «вспышки» не той темы.
// Порядок выбора: то, что вы выбрали сами → иначе тема вашей системы (телефона или компьютера).
(function () {
  var KEY = 'prorab-theme';

  function systemTheme() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function saved() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function apply(theme) {
    document.documentElement.setAttribute('data-theme', theme);
  }

  apply(saved() || systemTheme());

  window.ProrabTheme = {
    current: function () { return document.documentElement.getAttribute('data-theme'); },
    toggle: function () {
      var next = this.current() === 'dark' ? 'light' : 'dark';
      apply(next);
      try { localStorage.setItem(KEY, next); } catch (e) { /* хранилище недоступно — тема просто не запомнится */ }
      return next;
    }
  };
})();
