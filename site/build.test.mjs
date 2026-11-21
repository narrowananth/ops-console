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

test('the troubleshooting page has its place, its sections and its links', async () => {
  const slugs = DOCS.map(({ slug }) => slug);
  const at = slugs.indexOf('troubleshooting');
  assert.ok(at > -1, 'DOCS lists troubleshooting');
  assert.equal(slugs[at - 1], 'safety');
  assert.equal(slugs[at + 1], 'develop');
  await build();
  const page = await readFile(path.join(dist, 'docs', 'troubleshooting', 'index.html'), 'utf8');
  const sections = [...page.matchAll(/<h2 id="[^"]+">([^<]+)<\/h2>/g)].map(([, text]) => text);
  assert.deepEqual(sections, [
    'Install',
    'Start and stop',
    'Keychain',
    'Run sandbox',
    'Permissions',
    'When it is not here',
  ]);
  const install = await readFile(path.join(dist, 'docs', 'install', 'index.html'), 'utf8');
  assert.match(
    install.slice(install.indexOf('<article')),
    /href="\/docs\/troubleshooting\/"/,
    'Install links it in the text',
  );
  const index = await readFile(path.join(dist, 'docs', 'index.html'), 'utf8');
  assert.match(index, /class="card" href="\/docs\/troubleshooting\/"/, 'the docs index has its card');
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

test('the data-flow summary in PRIVACY.md comes before the table of what leaves, and links the docs page by full address', async () => {
  const source = await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'PRIVACY.md'), 'utf8');
  const flow = source.indexOf('\n## Data flow\n');
  assert.ok(flow > -1, 'PRIVACY.md has a Data flow section');
  assert.ok(flow < source.indexOf('\n## What leaves your Mac\n'), 'Data flow comes before What leaves your Mac');
  for (const heading of ['## Google data', '## Your control']) {
    assert.ok(source.includes(`\n${heading}\n`), `${heading} stays`);
  }
  const section = source.slice(flow, source.indexOf('\n## What leaves your Mac\n'));
  assert.match(section, /https:\/\/opsconsole\.org\/docs\/data-flow\//);
});

test('the data-flow docs page sits between Claude accounts and Safety, and the site links it', async () => {
  const slugs = DOCS.map(({ slug }) => slug);
  const at = slugs.indexOf('data-flow');
  assert.ok(at > -1, 'DOCS lists data-flow');
  assert.equal(slugs[at - 1], 'claude-accounts');
  assert.equal(slugs[at + 1], 'safety');
  await build();
  const page = await readFile(path.join(dist, 'docs', 'data-flow', 'index.html'), 'utf8');
  assert.match(page, /<h1 id="data-flow">Data flow<\/h1>/);
  for (const from of ['docs/safety', 'privacy']) {
    const html = await readFile(path.join(dist, from, 'index.html'), 'utf8');
    assert.match(html, /href="(?:https:\/\/opsconsole\.org)?\/docs\/data-flow\/"/, `${from} links the data-flow page`);
  }
  const home = await readFile(path.join(dist, 'index.html'), 'utf8');
  assert.match(home, /href="\/docs\/data-flow\/"/);
});

test('the Connectors page lists sixteen Connectors and has OpenTelemetry logs, CloudWatch logs, Loki logs and New Relic logs sections', async () => {
  await build();
  const page = await readFile(path.join(dist, 'docs', 'connectors', 'index.html'), 'utf8');
  assert.match(page, /<h2 id="[^"]+">The sixteen Connectors<\/h2>/);
  const [table] = page.match(/<table>[\s\S]*?<\/table>/) ?? [];
  assert.ok(table, 'the page has the Connector table');
  assert.equal(table.match(/<tr><td>/g)?.length, 16, 'one row per Connector');
  assert.match(table, /<td>OpenTelemetry logs<\/td>/);
  assert.match(page, /<h2 id="opentelemetry-logs">OpenTelemetry logs<\/h2>/);
  assert.match(page, /<pre><code>[\s\S]*exporters:[\s\S]*<\/code><\/pre>/, 'the section shows a Collector config');
  assert.match(table, /<td>CloudWatch logs<\/td>/);
  const [section] = page.match(/<h2 id="cloudwatch-logs">CloudWatch logs<\/h2>[\s\S]*?(?=<h2 )/) ?? [];
  assert.ok(section, 'the page has a CloudWatch logs section');
  assert.match(section, /CloudWatchLogsReadOnlyAccess/);
  assert.match(section, /<code>statusCode<\/code>/, 'the section lists the JSON log fields');
  assert.match(
    section,
    /<pre><code>[\s\S]*&quot;status&quot;:502[\s\S]*<\/code><\/pre>/,
    'the section shows a log line',
  );
  assert.match(section, /per GB scanned/);
  assert.match(section, /Choose the Profile/);
  assert.match(section, /<code>aws login<\/code>/);
  assert.match(section, /<code>aws sso login<\/code>/);
  assert.match(section, /2\.32\.0/);
  assert.match(section, /<code>brew upgrade awscli<\/code>/);
  const [otel] = page.match(/<h2 id="opentelemetry-logs">OpenTelemetry logs<\/h2>[\s\S]*?(?=<h2 )/) ?? [];
  assert.match(otel, /Choose folder/);
  assert.match(otel, /no files were found/);
  assert.match(table, /<td>Loki logs<\/td>/);
  const [loki] = page.match(/<h2 id="loki-logs">Loki logs<\/h2>[\s\S]*?(?=<h2 )/) ?? [];
  assert.ok(loki, 'the page has a Loki logs section');
  assert.match(loki, /Grafana Cloud/);
  assert.match(loki, /self-hosted URL is no longer read/);
  assert.match(loki, /picker with their names/);
  assert.match(loki, /<code>service_name<\/code>/);
  assert.match(loki, /<code>deployment_environment_name<\/code>/);
  assert.match(loki, /<code>http_status_code<\/code>/, 'the section lists the log fields');
  assert.match(loki, /<pre><code>[\s\S]*&quot;status&quot;:502[\s\S]*<\/code><\/pre>/, 'the section shows a log line');
  assert.match(loki, /Keychain/);
  assert.match(loki, /5,000/);
  assert.match(loki, /only the server's read tools/);
  assert.doesNotMatch(loki, /brew install logcli/);
  assert.match(table, /<td>New Relic logs<\/td>/);
  const [newRelic] = page.match(/<h2 id="new-relic-logs">New Relic logs<\/h2>[\s\S]*?(?=<h2 )/) ?? [];
  assert.ok(newRelic, 'the page has a New Relic logs section');
  assert.match(newRelic, /US, EU or JP/);
  assert.match(newRelic, /login password once/);
  assert.match(newRelic, /<code>service\.name<\/code>/);
  assert.match(newRelic, /<code>environment<\/code>/);
  assert.match(newRelic, /<code>http\.response\.status_code<\/code>/, 'the section lists the log fields');
  assert.match(
    newRelic,
    /<pre><code>[\s\S]*&quot;http\.response\.status_code&quot;:502[\s\S]*<\/code><\/pre>/,
    'the section shows a log event',
  );
  assert.match(newRelic, /5,000/);
  assert.match(newRelic, /only the server's read tools/);
  assert.doesNotMatch(newRelic, /brew install newrelic-cli|NRAK-/);
});

test('the data-flow page puts the Log folder on the Mac and its records in a prompt only as Samples', async () => {
  await build();
  const page = await readFile(path.join(dist, 'docs', 'data-flow', 'index.html'), 'utf8');
  const [row] = page.match(/<tr><td>Log folder<\/td>[\s\S]*?<\/tr>/) ?? [];
  assert.ok(row, 'the By route table has a Log folder row');
  assert.match(row, /on your Mac/);
  assert.match(row, /only as Samples/);
});

test('the data-flow page says the daemon calls the AWS CLI and CloudWatch events reach Anthropic only as Samples or tool output', async () => {
  await build();
  const page = await readFile(path.join(dist, 'docs', 'data-flow', 'index.html'), 'utf8');
  const [row] = page.match(/<tr><td>AWS CLI and MCP Server<\/td>[\s\S]*?<\/tr>/) ?? [];
  assert.ok(row, 'the By route table has an AWS row');
  assert.match(row, /calls the AWS CLI as you/);
  assert.match(row, /calls AWS from there/);
  assert.match(row, /only as Samples in a prompt or as the agent's tool output/);
});

test('the data-flow page keeps logcli and newrelic out of the CLI group and says Loki lines and New Relic events reach Anthropic only as Samples or tool output', async () => {
  await build();
  const page = await readFile(path.join(dist, 'docs', 'data-flow', 'index.html'), 'utf8');
  const [cli] = page.match(/<tr><td>CLI the daemon calls<\/td>[\s\S]*?<\/tr>/) ?? [];
  assert.ok(cli, 'the By route table has the CLI row');
  assert.doesNotMatch(cli, /logcli|newrelic/);
  const [row] = page.match(/<tr><td>Hosted MCP server<\/td>[\s\S]*?<\/tr>/) ?? [];
  assert.ok(row, 'the By route table has a hosted MCP server row');
  assert.match(row, /Loki logs, New Relic logs/);
  assert.match(row, /token it holds in your Keychain/);
  assert.match(row, /never writes or refreshes/);
  assert.match(row, /no model turn/);
  assert.match(
    row,
    /Loki lines and New Relic events reach Anthropic only as Samples in a prompt or as the agent's tool output/,
  );
});

test('the install page has the Homebrew trust step between tap and install', async () => {
  await build();
  const page = await readFile(path.join(dist, 'docs', 'install', 'index.html'), 'utf8');
  const [commands] = page.match(/<pre><code>brew tap[\s\S]*?<\/code><\/pre>/) ?? [];
  assert.ok(commands, 'the page shows the Homebrew commands');
  const lines = commands.split('\n');
  const at = (start) => lines.findIndex((line) => line.includes(start));
  assert.ok(at('brew trust narrowananth/ops-console') > at('brew tap'), 'trust comes after tap');
  assert.ok(at('brew trust narrowananth/ops-console') < at('brew install ops-console'), 'trust comes before install');
});
