/**
 * A small browser driver over the Chrome DevTools Protocol.
 *
 * Why not Playwright: the container images here install no OS packages because
 * the Alpine CDN is unreachable behind a TLS-intercepting proxy, and Playwright
 * wants a browser download plus a driver process. Chrome is already installed
 * and Node 22 ships a WebSocket client, so this needs nothing that is not
 * already on the machine. It is deliberately small — the journey suites do the
 * thinking; this only moves the mouse and reads the page.
 *
 * Two decisions are load-bearing:
 *
 * 1. Clicks are dispatched as **real mouse events at real coordinates**, not
 *    `element.click()`. A synthetic `.click()` fires the handler even when the
 *    control is invisible, zero-sized, scrolled out of view, or covered by an
 *    overlay — every one of which is broken for a human being. Before clicking,
 *    `document.elementFromPoint` must return the element we aimed at (or a
 *    descendant of it), so "a click landed on something else" is a failure here
 *    rather than a mystery in production.
 *
 * 2. Every failed network response and every console error is captured and
 *    attributed to the interaction that caused it. A button that navigates
 *    correctly while its data request 500s looks fine in a screenshot.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

function findChrome() {
  const explicit = process.env.CHROME_PATH;
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`CHROME_PATH does not exist: ${explicit}`);
    return explicit;
  }
  const found = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      `Could not find Chrome. Set CHROME_PATH. Looked in:\n  ${CHROME_CANDIDATES.join('\n  ')}`,
    );
  }
  return found;
}

/**
 * Launch Chrome and attach to its first page.
 *
 * A throwaway profile directory is used per run. Sharing the default profile
 * makes runs depend on whatever state a previous run or the human's own
 * browsing left behind, which is precisely the class of hidden dependency these
 * suites exist to find.
 */
export async function launch({ headless = true, port = 9222, keepProfile = false } = {}) {
  const chrome = findChrome();
  const profile = join(tmpdir(), `ffp-ui-journey-${port}-${Date.now()}`);
  mkdirSync(profile, { recursive: true });

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-extensions',
    '--disable-renderer-backgrounding',
    // A fixed window size keeps element coordinates and screenshots comparable
    // between runs and between machines.
    '--window-size=1440,900',
    'about:blank',
  ];
  if (headless) args.unshift('--headless=new');

  const child = spawn(chrome, args, { detached: false, stdio: 'ignore', windowsHide: true });
  child.on('error', (err) => {
    throw new Error(`failed to launch Chrome: ${err.message}`);
  });

  // Poll the debugging endpoint rather than sleeping a fixed interval: on a
  // cold start Chrome can take several seconds, and on a warm one it is ready
  // almost immediately.
  let target = null;
  for (let i = 0; i < 80 && !target; i += 1) {
    await sleep(250);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (res.ok) target = (await res.json()).find((t) => t.type === 'page');
    } catch {
      /* not listening yet */
    }
  }
  if (!target) {
    child.kill();
    throw new Error(`Chrome did not open its debugging port on ${port}`);
  }

  const page = await attach(target.webSocketDebuggerUrl);
  page.close = async () => {
    try {
      page._ws.close();
    } catch {
      /* already gone */
    }
    child.kill();
    await sleep(300);
    if (!keepProfile) {
      try {
        rmSync(profile, { recursive: true, force: true });
      } catch {
        /* Chrome may still hold a lock; a temp dir left behind is harmless */
      }
    }
  };
  return page;
}

async function attach(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP socket failed to open')), {
      once: true,
    });
  });

  let nextId = 0;
  const pending = new Map();

  // Observations accumulate here and are drained per interaction by the suite.
  const observed = { consoleErrors: [], pageErrors: [], failedRequests: [] };
  const requestUrls = new Map();

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);

    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error)
        p.reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data)})`));
      else p.resolve(msg.result);
      return;
    }

    switch (msg.method) {
      case 'Runtime.consoleAPICalled':
        if (msg.params.type === 'error') {
          observed.consoleErrors.push(
            msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '),
          );
        }
        break;
      case 'Runtime.exceptionThrown':
        observed.pageErrors.push(
          msg.params.exceptionDetails.exception?.description ??
            msg.params.exceptionDetails.text ??
            'exception',
        );
        break;
      case 'Network.requestWillBeSent':
        requestUrls.set(msg.params.requestId, msg.params.request.url);
        break;
      case 'Network.responseReceived':
        if (msg.params.response.status >= 400) {
          observed.failedRequests.push({
            status: msg.params.response.status,
            url: msg.params.response.url,
          });
        }
        break;
      case 'Network.loadingFailed':
        // Ignore cancellations: an SPA aborts in-flight queries on navigation
        // as a matter of course, and that is not a defect.
        if (!msg.params.canceled) {
          observed.failedRequests.push({
            status: 'net-error',
            url: requestUrls.get(msg.params.requestId) ?? '(unknown)',
            error: msg.params.errorText,
          });
        }
        break;
      default:
        break;
    }
  });

  const send = (method, params = {}) => {
    const id = (nextId += 1);
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    }
    return r.result.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');

  const page = {
    _ws: ws,
    send,
    evaluate,

    /** Drain everything observed since the last drain. */
    drain() {
      const snapshot = {
        consoleErrors: [...observed.consoleErrors],
        pageErrors: [...observed.pageErrors],
        failedRequests: [...observed.failedRequests],
      };
      observed.consoleErrors.length = 0;
      observed.pageErrors.length = 0;
      observed.failedRequests.length = 0;
      return snapshot;
    },

    async goto(url) {
      await send('Page.navigate', { url });
      await page.settle();
    },

    /**
     * Wait for the page to stop changing rather than for a fixed interval.
     *
     * React Query renders a loading state first, so `readyState === 'complete'`
     * proves nothing about whether the data arrived. This waits for the visible
     * text to hold steady across consecutive samples, which is the observable
     * definition of "finished rendering".
     */
    async settle({ timeoutMs = 15_000, quietMs = 500 } = {}) {
      const deadline = Date.now() + timeoutMs;
      let previous = null;
      let stableSince = null;
      while (Date.now() < deadline) {
        await sleep(150);
        const now = await evaluate(
          `document.readyState + '|' + (document.body ? document.body.innerText.length : 0)`,
        ).catch(() => null);
        if (now === null) continue;
        if (now === previous) {
          stableSince ??= Date.now();
          if (Date.now() - stableSince >= quietMs && now.startsWith('complete')) return true;
        } else {
          previous = now;
          stableSince = null;
        }
      }
      return false;
    },

    async text() {
      return (await evaluate('document.body ? document.body.innerText : ""')) ?? '';
    },

    async url() {
      return await evaluate('location.pathname + location.search');
    },

    /** Every enabled, visible control a user could actually click, by name. */
    async controls() {
      return await evaluate(`(() => {
        const nodes = [...document.querySelectorAll('button, a[href], [role="button"]')];
        return nodes.map((el) => {
          const r = el.getBoundingClientRect();
          return {
            name: (el.innerText || el.getAttribute('aria-label') || el.title || '').trim(),
            tag: el.tagName.toLowerCase(),
            href: el.getAttribute('href'),
            disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
            visible: r.width > 0 && r.height > 0,
          };
        }).filter((c) => c.name.length > 0);
      })()`);
    },

    /**
     * Click the control whose accessible name matches, as a human would.
     *
     * Returns a report rather than throwing on a miss, so a suite can assert
     * "this control is absent for this role" as a first-class expectation
     * instead of catching an exception.
     */
    async click(name, { exact = false, nth = 0 } = {}) {
      const box = await evaluate(`(() => {
        const want = ${JSON.stringify(name)};
        const exact = ${JSON.stringify(exact)};
        const nodes = [...document.querySelectorAll('button, a[href], [role="button"], input[type="submit"]')];
        const named = nodes.filter((el) => {
          const label = (el.innerText || el.value || el.getAttribute('aria-label') || el.title || '').trim();
          return exact ? label === want : label.toLowerCase().includes(want.toLowerCase());
        });
        const el = named[${nth}];
        if (!el) return { found: false, candidates: nodes.length };
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) {
          return { found: true, clickable: false, reason: 'zero-sized' };
        }
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        // The element the browser would actually deliver the click to. If it is
        // neither our target nor inside it, something is covering the control.
        const hit = document.elementFromPoint(x, y);
        const covered = !(hit && (hit === el || el.contains(hit) || hit.contains(el)));
        return {
          found: true,
          clickable: !covered,
          reason: covered ? 'covered by ' + (hit ? hit.tagName.toLowerCase() + (hit.className ? '.' + String(hit.className).split(' ')[0] : '') : 'nothing') : null,
          disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
          x, y,
        };
      })()`);

      if (!box.found) return { ok: false, reason: 'not-found', ...box };
      if (!box.clickable) return { ok: false, reason: box.reason, ...box };
      if (box.disabled) return { ok: false, reason: 'disabled', ...box };

      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', {
          type,
          x: box.x,
          y: box.y,
          button: 'left',
          clickCount: 1,
        });
      }
      await page.settle();
      return { ok: true, x: box.x, y: box.y };
    },

    /** Type into a field the way a user does, so React's onChange actually runs. */
    async fill(selector, value) {
      const focused = await evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.focus();
        // Clear through the native setter so React sees the change.
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
        Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, '');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      if (!focused) return false;
      for (const char of String(value)) {
        await send('Input.dispatchKeyEvent', { type: 'char', text: char });
      }
      return true;
    },

    async screenshot(path) {
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, Buffer.from(data, 'base64'));
      return path;
    },

    /** Wipe the persisted session so the next role starts genuinely signed out. */
    async clearSession() {
      await evaluate('localStorage.clear(); sessionStorage.clear(); true');
      await send('Network.clearBrowserCookies');
    },
  };

  return page;
}
