// Runs before the page paints. Light unless the visitor chose dark with the button in the header.
try {
  if (localStorage.getItem('theme') === 'dark') document.documentElement.dataset.theme = 'dark';
} catch {}
