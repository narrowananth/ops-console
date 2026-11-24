# Website

**Status:** shipped
**Design:** none: a static site in the app's colours, with the layout of a docs site (header, docs sidebar, footer in columns).

## Problem

The project has no public home. Google's consent screen needs a home page, a privacy policy and terms on a domain the project owns, and users have nowhere to read how to install, use and trust Ops Console outside the repo.

## Behavior

1. `site/` builds opsconsole.org with `node site/build.mjs` into `site/dist`: no dependencies, no framework.
2. Pages: the home page; docs (`/docs/` and eleven pages); release notes (`/releases/`); `/privacy/` and `/terms/`; a 404 page; `sitemap.xml` and `robots.txt`.
3. The home page names the app, says what it does, shows the install command with a copy button, and links the privacy policy and terms. Every page links both in its footer.
4. Docs are Markdown in `site/content/docs/`. Privacy and terms are built from the root `PRIVACY.md` and `TERMS.md`, so the repo and the site hold one text. A link in them to `PRIVACY.md`, `TERMS.md`, `LICENSE` or `NOTICE` goes to the site page or to GitHub.
5. Release notes load in the visitor's browser from GitHub's releases API, so a new release shows without a site build. Without JavaScript, or when GitHub does not answer, the page links the releases on GitHub.
6. The site loads nothing from a third party: system fonts, no analytics, no cookies. The build writes a response header policy (`_headers`) that allows scripts, styles and images from the site only, and the one outside request, GitHub's API.
7. The site is light until the visitor picks dark with the button in the header, and the choice persists. A narrow screen stacks the layout.

## Settled

- **Host**: Cloudflare, where the domain is registered. Workers Builds deploys `main` with `wrangler.jsonc`, which serves `site/dist` as static assets and answers a missing page with `404.html`.
- **Domain**: `opsconsole.org`.
- **Colours**: the app's tokens (`frontend/src/styles/theme.css`), light and dark.
- **Check**: `pnpm check` runs `site/build.test.mjs`: the Markdown converter, every page built, each page linking privacy and terms, every internal link landing on a page, and no third-party asset.

## Not required

- Search, a blog, a docs version picker and translations.
- Analytics. Cloudflare's Web Analytics stays off, and the privacy policy says so.

## Out of scope

- Google's brand verification and app verification: the site only supplies the pages they need.

## Seams

- **Node test** (`site/build.test.mjs`): 1 to 4 and 6.
- **Browser** (Playwright screenshots by hand): 5 and 7.
