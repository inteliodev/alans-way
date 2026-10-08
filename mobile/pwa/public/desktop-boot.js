(function () {
  var saved = '';
  try { saved = localStorage.getItem('intelio-theme') || ''; } catch (e) { saved = ''; }
  var theme = saved === 'dark' || saved === 'blue' ? saved : 'light';
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme === 'light' ? 'light' : 'dark';
  try {
    if (window.matchMedia && window.matchMedia('(max-width: 999px)').matches) location.replace('/');
  } catch (e) { /* stay on this page if the viewport cannot be read */ }
})();
