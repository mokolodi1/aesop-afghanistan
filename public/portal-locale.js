(function () {
  try {
    if (localStorage.getItem('portalLocale') === 'fa') {
      document.documentElement.lang = 'fa-AF';
      document.documentElement.dir = 'rtl';
    }
  } catch (e) {}
})();
