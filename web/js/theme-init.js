// Apply the saved theme before first paint to avoid a flash of the wrong one.
try {
  var theme = JSON.parse(localStorage.getItem('oujda-transit.theme'));
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch (e) {}
