// Builds the opsconsole.org site into site/dist: `node site/build.mjs`. No dependencies.
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
export const ORIGIN = 'https://opsconsole.org';
export const REPO = 'https://github.com/narrowananth/ops-console';

/** The docs pages, in the order the sidebar lists them. */
export const DOCS = [
  { slug: 'install', title: 'Install and update' },
  { slug: 'quick-start', title: 'Quick start' },
  { slug: 'sessions', title: 'Sessions and Access modes' },
  { slug: 'monitor', title: 'Monitor and Playbooks' },
  { slug: 'connectors', title: 'Connectors' },
  { slug: 'google', title: 'Google Docs, Sheets and Drive' },
  { slug: 'claude-accounts', title: 'Claude accounts and CLIProxy' },
  { slug: 'data-flow', title: 'Data flow' },
  { slug: 'safety', title: 'Safety' },
  { slug: 'troubleshooting', title: 'Troubleshooting' },
  { slug: 'develop', title: 'Run from source' },
];

const escapeHtml = (text) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const slugify = (text) =>
  text
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** Inline Markdown: code, links and bold. `href` rewrites a link target. */
function inline(text, href) {
  const codes = [];
  let out = text.replace(/`([^`]+)`/g, (_m, code) => {
    codes.push(`<code>${escapeHtml(code)}</code>`);
    return `\uE000${codes.length - 1}\uE000`;
  });
  out = escapeHtml(out)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, target) => `<a href="${escapeHtml(href(target))}">${label}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return out.replace(/\uE000(\d+)\uE000/g, (_m, i) => codes[Number(i)]);
}

const cells = (line) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim());

/**
 * Markdown to HTML: headings, paragraphs, lists, tables, fenced code, block quotes and rules. Headings get ids.
 * Returns the HTML and the headings found.
 */
export function markdown(source, href = (target) => target) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const html = [];
  const headings = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '') {
      i += 1;
      continue;
    }
    const fence = /^```(\w*)/.exec(line);
    if (fence) {
      const body = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? '').startsWith('```')) {
        body.push(lines[i] ?? '');
        i += 1;
      }
      i += 1;
      html.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const id = slugify(heading[2]);
      headings.push({ level, id, text: heading[2].replace(/`/g, '') });
      html.push(`<h${level} id="${id}">${inline(heading[2], href)}</h${level}>`);
      i += 1;
      continue;
    }
    if (/^---+\s*$/.test(line)) {
      html.push('<hr>');
      i += 1;
      continue;
    }
    if (line.trim().startsWith('|') && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) {
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && (lines[i] ?? '').trim().startsWith('|')) {
        rows.push(cells(lines[i] ?? ''));
        i += 1;
      }
      const th = head.map((cell) => `<th>${inline(cell, href)}</th>`).join('');
      const tr = rows.map((row) => `<tr>${row.map((cell) => `<td>${inline(cell, href)}</td>`).join('')}</tr>`).join('');
      html.push(`<div class="table"><table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const body = [];
      while (i < lines.length && /^>\s?/.test(lines[i] ?? '')) {
        body.push((lines[i] ?? '').replace(/^>\s?/, ''));
        i += 1;
      }
      html.push(`<blockquote><p>${inline(body.join(' '), href)}</p></blockquote>`);
      continue;
    }
    const list = /^(\s*)([-*]|\d+\.)\s+/.exec(line);
    if (list) {
      const ordered = /\d/.test(list[2] ?? '');
      const items = [];
      while (i < lines.length) {
        const row = lines[i] ?? '';
        const start = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(row);
        if (start) {
          items.push(start[2] ?? '');
        } else if (/^\s{2,}\S/.test(row) && items.length > 0) {
          items[items.length - 1] += ` ${row.trim()}`;
        } else {
          break;
        }
        i += 1;
      }
      const tag = ordered ? 'ol' : 'ul';
      html.push(`<${tag}>${items.map((item) => `<li>${inline(item, href)}</li>`).join('')}</${tag}>`);
      continue;
    }
    const para = [];
    while (
      i < lines.length &&
      (lines[i] ?? '').trim() !== '' &&
      !/^(#{1,4}\s|```|>\s?|\s*([-*]|\d+\.)\s|\s*\|)/.test(lines[i] ?? '')
    ) {
      para.push((lines[i] ?? '').trim());
      i += 1;
    }
    if (para.length === 0) {
      para.push(line.trim());
      i += 1;
    }
    html.push(`<p>${inline(para.join(' '), href)}</p>`);
  }
  return { html: html.join('\n'), headings };
}

/** The first heading's text and the first paragraph's, as a page title and description. */
function summary(source) {
  const title = /^#\s+(.*)$/m.exec(source)?.[1]?.replace(/`/g, '') ?? '';
  const first = source
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '' && !/^(#|\||```|>|[-*]\s|\d+\.\s)/.test(line));
  const description = (first ?? '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[`*]/g, '');
  return { title, description };
}

/** Sends a link in the repo's own Markdown to its place on the site or on GitHub. */
export function siteHref(target) {
  const known = {
    'PRIVACY.md': '/privacy/',
    'TERMS.md': '/terms/',
    LICENSE: `${REPO}/blob/main/LICENSE`,
    NOTICE: `${REPO}/blob/main/NOTICE`,
  };
  return known[target] ?? target;
}

const NAV = [
  { href: '/docs/', label: 'Docs' },
  { href: '/releases/', label: 'Releases' },
  { href: REPO, label: 'GitHub' },
];

const FOOTER = [
  {
    heading: 'Product',
    links: [
      ['Overview', '/'],
      ['Connectors', '/docs/connectors/'],
      ['Google Workspace', '/docs/google/'],
      ['Safety', '/docs/safety/'],
    ],
  },
  {
    heading: 'Resources',
    links: [
      ['Docs home', '/docs/'],
      ['Install the CLI', '/docs/install/'],
      ['Release notes', '/releases/'],
      ['Source code', REPO],
    ],
  },
  {
    heading: 'Legal',
    links: [
      ['Privacy policy', '/privacy/'],
      ['Terms of service', '/terms/'],
      ['MIT License', `${REPO}/blob/main/LICENSE`],
    ],
  },
];

/** One full page around `body`. `url` is the page's path, such as `/docs/install/`. */
export function layout({ title, description, url, body, bodyClass = '' }) {
  const full =
    title === 'Ops Console' ? 'Ops Console: a local console on top of Claude Code' : `${title} · Ops Console`;
  const nav = NAV.map(
    ({ href, label }) =>
      `<a href="${href}"${url.startsWith(href) && href !== REPO ? ' aria-current="page"' : ''}>${label}</a>`,
  ).join('');
  const columns = FOOTER.map(
    ({ heading, links }) =>
      `<nav class="foot-col" aria-label="${heading}"><h2>${heading}</h2>${links
        .map(([label, href]) => `<a href="${href}">${label}</a>`)
        .join('')}</nav>`,
  ).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(full)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${ORIGIN}${url}">
<link rel="icon" type="image/svg+xml" href="/assets/favicon.svg">
<script src="/assets/theme.js"></script>
<link rel="stylesheet" href="/assets/styles.css">
<meta property="og:title" content="${escapeHtml(full)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${ORIGIN}${url}">
<meta property="og:type" content="website">
<meta property="og:image" content="${ORIGIN}/assets/logo.png">
<script src="/assets/site.js" defer></script>
</head>
<body class="${bodyClass}">
<a class="skip" href="#main">Skip to content</a>
<header class="top">
  <div class="wrap top-row">
    <a class="brand" href="/"><img src="/assets/logo.png" alt="" width="28" height="28"><span>Ops Console</span></a>
    <nav class="nav" aria-label="Main">${nav}</nav>
    <button class="theme-toggle" type="button" data-theme-toggle aria-label="Switch between light and dark">
      <svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
      <svg class="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
    </button>
    <a class="button small" href="/docs/install/">Install</a>
  </div>
</header>
<main id="main">
${body}
</main>
<footer class="foot">
  <div class="wrap foot-grid">
    <div class="foot-about">
      <a class="brand" href="/"><img src="/assets/logo.png" alt="" width="28" height="28"><span>Ops Console</span></a>
      <p>A local console on top of Claude Code. It runs on your Mac, shows how your services are doing, and lets the agent change code only after you approve.</p>
    </div>
    ${columns}
  </div>
  <div class="wrap foot-base"><p>© 2026 Ops Console. Open source under the MIT License.</p></div>
</footer>
</body>
</html>
`;
}

async function write(file, content) {
  const target = path.join(here, 'dist', file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

const read = (file) => readFile(file, 'utf8');

function docsBody(slug, article, headings) {
  const side = DOCS.map(
    ({ slug: other, title }) =>
      `<a href="/docs/${other}/"${other === slug ? ' aria-current="page"' : ''}>${escapeHtml(title)}</a>`,
  ).join('');
  const toc = headings
    .filter((heading) => heading.level === 2)
    .map((heading) => `<a href="#${heading.id}">${escapeHtml(heading.text)}</a>`)
    .join('');
  const index = DOCS.findIndex((doc) => doc.slug === slug);
  const next = DOCS[index + 1];
  const previous = DOCS[index - 1];
  const pager = `<nav class="pager" aria-label="Pages">${
    previous ? `<a href="/docs/${previous.slug}/">← ${escapeHtml(previous.title)}</a>` : '<span></span>'
  }${next ? `<a href="/docs/${next.slug}/">${escapeHtml(next.title)} →</a>` : '<span></span>'}</nav>`;
  return `<div class="wrap docs">
  <nav class="docs-side" aria-label="Docs">${side}</nav>
  <article class="prose">${article}${pager}
  </article>
  ${toc ? `<nav class="docs-toc" aria-label="On this page"><h2>On this page</h2>${toc}</nav>` : ''}
</div>`;
}

export async function build() {
  await rm(path.join(here, 'dist'), { recursive: true, force: true });
  await cp(path.join(here, 'assets'), path.join(here, 'dist', 'assets'), { recursive: true });
  const pages = [];

  const home = await read(path.join(here, 'content', 'index.html'));
  await write(
    'index.html',
    layout({
      title: 'Ops Console',
      description:
        'Ops Console is an open-source local console on top of Claude Code. It watches your services, and the agent fixes code and opens pull requests only after you approve. It never merges.',
      url: '/',
      body: home,
      bodyClass: 'home',
    }),
  );
  pages.push('/');

  const index = await read(path.join(here, 'content', 'docs', 'index.md'));
  const indexSummary = summary(index);
  const rendered = markdown(index, siteHref);
  const cards = DOCS.map(
    ({ slug, title }) => `<a class="card" href="/docs/${slug}/"><h3>${escapeHtml(title)}</h3></a>`,
  ).join('');
  await write(
    'docs/index.html',
    layout({
      title: 'Docs',
      description: indexSummary.description,
      url: '/docs/',
      body: docsBody('', `${rendered.html}<div class="cards">${cards}</div>`, rendered.headings).replace(
        /<nav class="pager"[\s\S]*?<\/nav>/,
        '',
      ),
    }),
  );
  pages.push('/docs/');

  for (const { slug } of DOCS) {
    const source = await read(path.join(here, 'content', 'docs', `${slug}.md`));
    const { html, headings } = markdown(source, siteHref);
    const { title, description } = summary(source);
    await write(
      `docs/${slug}/index.html`,
      layout({ title, description, url: `/docs/${slug}/`, body: docsBody(slug, html, headings) }),
    );
    pages.push(`/docs/${slug}/`);
  }

  for (const [file, slug] of [
    ['PRIVACY.md', 'privacy'],
    ['TERMS.md', 'terms'],
  ]) {
    const source = await read(path.join(root, file));
    const { html } = markdown(source, siteHref);
    const { title, description } = summary(source);
    await write(
      `${slug}/index.html`,
      layout({
        title,
        description,
        url: `/${slug}/`,
        body: `<div class="wrap narrow"><article class="prose">${html}</article></div>`,
      }),
    );
    pages.push(`/${slug}/`);
  }

  const releases = await read(path.join(here, 'content', 'releases.html'));
  await write(
    'releases/index.html',
    layout({
      title: 'Release notes',
      description: 'What changed in each Ops Console release, with the download for each.',
      url: '/releases/',
      body: releases,
    }),
  );
  pages.push('/releases/');

  await write(
    '404.html',
    layout({
      title: 'Page not found',
      description: 'That page is not here.',
      url: '/404.html',
      body: `<div class="wrap narrow"><article class="prose"><h1>Page not found</h1><p>That page is not here. Try the <a href="/docs/">docs</a>, or go back to the <a href="/">home page</a>.</p></article></div>`,
    }),
  );
  await write(
    'sitemap.xml',
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages
      .map((page) => `  <url><loc>${ORIGIN}${page}</loc></url>`)
      .join('\n')}\n</urlset>\n`,
  );
  await write('robots.txt', `User-agent: *\nAllow: /\nSitemap: ${ORIGIN}/sitemap.xml\n`);
  await write(
    '_headers',
    `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  X-Frame-Options: DENY
  Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self' https://api.github.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
/assets/*
  Cache-Control: public, max-age=3600
`,
  );
  return pages;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pages = await build();
  console.log(`site: ${pages.length} pages in site/dist`);
}
