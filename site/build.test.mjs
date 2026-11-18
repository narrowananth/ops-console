import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build, DOCS, markdown, siteHref } from './build.mjs';

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');

test('markdown turns headings, lists, tables, code and links into HTML, and escapes the rest', () => {
  const { html, headings } = markdown(
    [
      '# Title `x`',
      '',
      'A <b>bold</b> move with **strong**, `a<b` and [a link](/docs/).',
      '',
      '- one',
      '- two',
      '  more',
      '',
      '1. first',
      '',
      '| A | B |',
      '| - | - |',
      '| `c` | d |',
      '',
      '```',
      '<script>',
      '```',
    ].join('\n'),
  );
  assert.deepEqual(headings, [{ level: 1, id: 'title-x', text: 'Title x' }]);
  assert.match(html, /<h1 id="title-x">Title <code>x<\/code><\/h1>/);
  assert.match(
    html,
    /A &lt;b&gt;bold&lt;\/b&gt; move with <strong>strong<\/strong>, <code>a&lt;b<\/code> and <a href="\/docs\/">a link<\/a>/,
  );
  assert.match(html, /<ul><li>one<\/li><li>two more<\/li><\/ul>/);
  assert.match(html, /<ol><li>first<\/li><\/ol>/);
  assert.match(html, /<th>A<\/th><th>B<\/th>[\s\S]*<td><code>c<\/code><\/td><td>d<\/td>/);
  assert.match(html, /<pre><code>&lt;script&gt;<\/code><\/pre>/);
});

test("the repo's own links point at the site or at GitHub", () => {
  assert.equal(siteHref('PRIVACY.md'), '/privacy/');
  assert.equal(siteHref('TERMS.md'), '/terms/');
  assert.match(siteHref('LICENSE'), /^https:\/\/github\.com\/narrowananth\/ops-console\/blob\/main\/LICENSE$/);
  assert.equal(siteHref('/docs/'), '/docs/');
});

test('the build writes every page, with the links Google asks of a home page', async () => {
  const pages = await build();
  const expected = ['/', '/docs/', ...DOCS.map(({ slug }) => `/docs/${slug}/`), '/privacy/', '/terms/', '/releases/'];
  assert.deepEqual(pages.toSorted(), expected.toSorted());
  for (const page of pages) {
    const html = await readFile(path.join(dist, page, page.endsWith('/') ? 'index.html' : ''), 'utf8');
    assert.match(html, /<title>[^<]+<\/title>/, page);
    assert.match(html, /href="\/privacy\/"/, `${page} links the privacy policy`);
    assert.match(html, /href="\/terms\/"/, `${page} links the terms`);
    assert.match(html, /<script src="\/assets\/theme\.js"><\/script>/, `${page} sets the theme before it paints`);
    assert.match(html, /data-theme-toggle/, `${page} has the theme button`);
  }
  const privacy = await readFile(path.join(dist, 'privacy', 'index.html'), 'utf8');
  assert.match(privacy, /<h1 id="privacy-policy">Privacy policy<\/h1>/);
  assert.doesNotMatch(privacy, /PRIVACY\.md|TERMS\.md/);
  const sitemap = await readFile(path.join(dist, 'sitemap.xml'), 'utf8');
  assert.match(sitemap, /<loc>https:\/\/opsconsole\.org\/privacy\/<\/loc>/);
});

test('no page loads anything from a third party, and every internal link has a page', async () => {
  const pages = await build();
  const known = new Set(pages);
  for (const page of pages) {
    const html = await readFile(path.join(dist, page, page.endsWith('/') ? 'index.html' : ''), 'utf8');
    assert.doesNotMatch(
      html,
      /<(?:script|link|img)[^>]+(?:src|href)="https?:\/\/(?!github\.com|opsconsole\.org)/,
      page,
    );
    for (const [, href] of html.matchAll(/href="(\/[^"#]*)"/g)) {
      assert.ok(known.has(href) || href.startsWith('/assets/'), `${page} links ${href}, which is no page`);
    }
  }
});
