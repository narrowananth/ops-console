// Three small jobs: the theme button, the copy button on the install command, and the release list on /releases/.
const toggle = document.querySelector('[data-theme-toggle]');
toggle?.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  if (next === 'dark') document.documentElement.dataset.theme = 'dark';
  else delete document.documentElement.dataset.theme;
  try {
    localStorage.setItem('theme', next);
  } catch {}
});

for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.copy ?? '');
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Press ⌘C';
    }
    setTimeout(() => {
      button.textContent = 'Copy';
    }, 1600);
  });
}

const list = document.getElementById('releases');
if (list) {
  const repo = list.dataset.repo;
  const status = list.querySelector('.status');
  const node = (tag, text, attrs = {}) => {
    const el = document.createElement(tag);
    if (text) el.textContent = text;
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
    return el;
  };
  fetch(`https://api.github.com/repos/${repo}/releases?per_page=30`, {
    headers: { accept: 'application/vnd.github+json' },
  })
    .then((response) => {
      if (!response.ok) throw new Error(String(response.status));
      return response.json();
    })
    .then((releases) => {
      status?.remove();
      for (const release of releases.filter((item) => !item.draft)) {
        const card = node('article', '', { class: 'release', id: release.tag_name });
        const head = node('h2');
        head.append(node('a', release.name || release.tag_name, { href: release.html_url }));
        card.append(head);
        if (release.published_at) {
          const when = new Date(release.published_at);
          card.append(
            node('time', when.toLocaleDateString('en', { year: 'numeric', month: 'long', day: 'numeric' }), {
              datetime: release.published_at,
            }),
          );
        }
        const items = node('ul');
        for (const line of (release.body || '').split('\n')) {
          const match =
            /^\s*[*-]\s+(.*?)(?:\s+by\s+@\S+)?(?:\s+in\s+(https:\/\/github\.com\/\S+\/pull\/(\d+)))?\s*$/.exec(line);
          if (!match) continue;
          const row = node('li', match[1]);
          if (match[2]) {
            row.append(' (');
            row.append(node('a', `#${match[3]}`, { href: match[2] }));
            row.append(')');
          }
          items.append(row);
        }
        if (items.childElementCount > 0) card.append(items);
        const downloads = node('p', '', { class: 'downloads' });
        for (const asset of release.assets || []) {
          if (asset.name.endsWith('.tar.gz'))
            downloads.append(node('a', asset.name, { href: asset.browser_download_url }));
        }
        if (downloads.childElementCount > 0) card.append(downloads);
        list.append(card);
      }
    })
    .catch(() => {
      if (status) {
        status.textContent = 'The list could not load. ';
        status.append(node('a', 'See the releases on GitHub.', { href: `https://github.com/${repo}/releases` }));
      }
    });
}
