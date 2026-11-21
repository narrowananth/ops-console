import type { ElementCapture } from '@ops-console/shared';
import type { CDPSession } from 'playwright-core';
import { redact } from '../action-log/redact';

const TEXT_CHARS = 300;
const HTML_CHARS = 2000;
const VALUE_CHARS = 200;
/** A crop is never larger than this, in CSS pixels. */
const CROP_MAX = { width: 1000, height: 800 };
const READ_WAIT_MS = 6000;

/** What the page script returns. Values are untrusted page text until `describe` redacts them. */
type Raw = {
  tag: string;
  id: string | null;
  classes: string[];
  text: string;
  label: string;
  attributes: Record<string, string>;
  html: string;
  box: { x: number; y: number; width: number; height: number };
  styles: Record<string, string>;
  selector: string;
  url: string;
  title: string;
  /** The element is, or holds, a field with something typed, a password field or an editable region. */
  typed: boolean;
};

/**
 * Runs in the page with the picked element as `this`. It reads the element's markup and visible text and never an input's
 * value, a cookie or storage. Plain JavaScript in a string: the page runs it, not this build.
 */
const READ_ELEMENT = `function () {
  var el = this;
  var TEXT = ${TEXT_CHARS}, HTML = ${HTML_CHARS}, VALUE = ${VALUE_CHARS};
  var FIELDS = 'input,textarea,select,[contenteditable]:not([contenteditable=false])';
  var SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|TEXTAREA|SELECT|INPUT)$/;
  var cut = function (value, max) { return value.length > max ? value.slice(0, max) + '…' : value; };
  var isField = function (node) { return node.matches && node.matches(FIELDS); };

  var typed = isField(el) || !!el.querySelector(FIELDS);

  // Visible text, walking text nodes so a field's value is never read and hidden text is skipped.
  var text = '';
  if (!typed || !isField(el)) {
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        for (var p = node.parentElement; p; p = p.parentElement) {
          if (SKIP.test(p.tagName) || isField(p)) return NodeFilter.FILTER_REJECT;
          var style = getComputedStyle(p);
          if (style.display === 'none' || style.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
          if (p === el) break;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    for (var n = walker.nextNode(); n && text.length < TEXT * 2; n = walker.nextNode()) text += n.nodeValue + ' ';
    text = cut(text.replace(/\\s+/g, ' ').trim(), TEXT);
  }

  // Markup with every value taken out.
  var copy = el.cloneNode(true);
  var strip = function (node) {
    if (node.tagName === 'INPUT') { node.removeAttribute('value'); node.removeAttribute('checked'); }
    else if (node.tagName === 'TEXTAREA' || node.tagName === 'SCRIPT' || node.tagName === 'STYLE') node.textContent = '';
    else if (node.matches && node.matches('[contenteditable]:not([contenteditable=false])')) node.textContent = '';
    for (var i = 0; i < node.attributes.length; i++) {
      var attr = node.attributes[i];
      if (attr.value.length > VALUE) node.setAttribute(attr.name, attr.value.slice(0, VALUE) + '…');
    }
  };
  strip(copy);
  copy.querySelectorAll('*').forEach(strip);
  var html = cut(copy.outerHTML, HTML);

  var attributes = {};
  var KEPT = /^(href|src|alt|title|type|name|placeholder|for|role|data-testid|aria-[a-z-]+)$/;
  for (var a = 0; a < el.attributes.length; a++) {
    var at = el.attributes[a];
    if (KEPT.test(at.name)) attributes[at.name] = cut(at.value, VALUE);
  }

  // A path from body that finds this element: an id or test id when it is unique, else the tag and its place among siblings.
  var unique = function (css) { try { return document.querySelectorAll(css).length === 1; } catch (e) { return false; } };
  var part = function (node) {
    var tag = node.tagName.toLowerCase();
    if (node.id) { var byId = '#' + CSS.escape(node.id); if (unique(byId)) return { css: byId, done: true }; }
    var test = node.getAttribute('data-testid');
    if (test) { var byTest = tag + '[data-testid="' + CSS.escape(test) + '"]'; if (unique(byTest)) return { css: byTest, done: true }; }
    var same = node.parentElement ? Array.prototype.filter.call(node.parentElement.children, function (c) { return c.tagName === node.tagName; }) : [];
    return { css: same.length > 1 ? tag + ':nth-of-type(' + (same.indexOf(node) + 1) + ')' : tag, done: false };
  };
  var path = [];
  for (var cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
    var step = part(cur);
    path.unshift(step.css);
    if (step.done || cur.tagName === 'BODY' || cur.tagName === 'HTML') break;
  }

  var rect = el.getBoundingClientRect();
  var computed = getComputedStyle(el);
  var label = el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title') || '';
  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || null,
    classes: Array.prototype.slice.call(el.classList, 0, 8),
    text: text,
    label: label,
    attributes: attributes,
    html: html,
    box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    styles: {
      color: computed.color,
      'background-color': computed.backgroundColor,
      'font-size': computed.fontSize,
      display: computed.display,
      position: computed.position
    },
    selector: path.join(' > '),
    url: location.href,
    title: document.title,
    typed: typed || (el.tagName === 'INPUT' && el.type === 'password')
  };
}`;

/** How far the page is scrolled, in CSS pixels: Chrome's hit test and screenshot clip count from the top of the document. */
export async function scrolled(cdp: CDPSession): Promise<{ x: number; y: number }> {
  const { cssVisualViewport: view } = await cdp.send('Page.getLayoutMetrics');
  return { x: view.pageX, y: view.pageY };
}

/** The element at a point of the viewport, from Chrome's own hit test; `null` for the page's own `html` and `body`. */
export async function elementAt(cdp: CDPSession, x: number, y: number): Promise<number | null> {
  const at = await scrolled(cdp).catch(() => ({ x: 0, y: 0 }));
  const hit = await cdp
    .send('DOM.getNodeForLocation', { x: Math.round(x + at.x), y: Math.round(y + at.y) })
    .catch(() => null);
  if (!hit) return null;
  const { node } = await cdp
    .send('DOM.describeNode', { backendNodeId: hit.backendNodeId })
    .catch(() => ({ node: null }));
  if (node?.nodeType !== 1 || /^(html|body)$/i.test(node.nodeName)) return null;
  return hit.backendNodeId;
}

/** Rejects when Chrome does not answer: a page that navigates under a call leaves it pending. */
export function within<T>(work: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('The page did not answer, so nothing was picked. Try again.')),
      READ_WAIT_MS,
    );
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** What Chrome calls the element: its role and accessible name from the accessibility tree. */
async function accessible(cdp: CDPSession, backendNodeId: number): Promise<{ role: string | null; name: string }> {
  const tree = await cdp
    .send('Accessibility.getPartialAXTree', { backendNodeId, fetchRelatives: false })
    .catch(() => null);
  const node = tree?.nodes.find((candidate) => candidate.backendDOMNodeId === backendNodeId) ?? tree?.nodes[0];
  const role = String(node?.role?.value ?? '');
  return {
    role: role === '' || role === 'none' || role === 'generic' ? null : role,
    name: String(node?.name?.value ?? ''),
  };
}

const redactAll = (values: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(values).map(([key, value]) => [key, redact(value)]));

/**
 * Reads the node into an `ElementCapture`. `crop` takes the JPEG of a box in CSS pixels, or null; it is called with the
 * part of the box inside the page and the scale that keeps it within the cap.
 */
export async function captureElement(
  cdp: CDPSession,
  backendNodeId: number,
  crop: (clip: { x: number; y: number; width: number; height: number }, scale: number) => Promise<string | null>,
  page: { width: number; height: number },
): Promise<ElementCapture> {
  const { object } = await within(cdp.send('DOM.resolveNode', { backendNodeId }));
  const objectId = object.objectId;
  if (!objectId) throw new Error('The element is gone');
  let raw: Raw;
  try {
    const result = await within(
      cdp.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: READ_ELEMENT,
        returnByValue: true,
        silent: true,
      }),
    );
    if (result.exceptionDetails || result.result.value === undefined) throw new Error('The element could not be read');
    raw = result.result.value as Raw;
  } finally {
    void cdp.send('Runtime.releaseObject', { objectId }).catch(() => {});
  }

  const { role, name } = await accessible(cdp, backendNodeId);
  const visible = {
    x: Math.max(0, raw.box.x),
    y: Math.max(0, raw.box.y),
    width: Math.min(page.width, raw.box.x + raw.box.width) - Math.max(0, raw.box.x),
    height: Math.min(page.height, raw.box.y + raw.box.height) - Math.max(0, raw.box.y),
  };
  const scale = Math.min(1, CROP_MAX.width / visible.width, CROP_MAX.height / visible.height);
  // A crop shows what is typed in a field, so a field's element has none.
  const image =
    raw.typed || visible.width < 1 || visible.height < 1 ? null : await crop(visible, scale).catch(() => null);

  return {
    page_url: redact(raw.url),
    page_title: redact(raw.title),
    tag: raw.tag,
    selector: raw.selector,
    id: raw.id,
    classes: raw.classes,
    role,
    name: redact(name || raw.label),
    text: redact(raw.text),
    attributes: redactAll(raw.attributes),
    html: redact(raw.html),
    box: raw.box,
    styles: raw.styles,
    crop: image,
  };
}
