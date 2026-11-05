const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'bilibili-freeview.js'), 'utf8');

function startScript(protocolEnabled, failStyle = false) {
  const commands = [];
  const listeners = {};
  class Element {
    constructor() { this.style = { setProperty() {} }; this.dataset = {}; this.isConnected = false; }
    addEventListener() {}
    appendChild(child) { child.isConnected = true; return child; }
    querySelectorAll() { return []; }
    querySelector() { return new Element(); }
    closest() { return null; }
    setAttribute() {}
  }
  class HTMLMediaElement extends Element {}
  Object.defineProperty(HTMLMediaElement.prototype, 'playbackRate', {
    get() { return 1; }, set() {}, configurable: true,
  });
  const body = new Element();
  const document = {
    body, head: new Element(), documentElement: new Element(), cookie: '', readyState: 'loading', hidden: false,
    createElement: () => new Element(), querySelector: () => null, querySelectorAll: () => [],
    getElementById: () => null,
    addEventListener(name, fn) { (listeners[name] ||= []).push(fn); },
  };
  const location = new URL('https://www.bilibili.com/video/BV1WkxP6nEd6/?p=1');
  const storage = { getItem() { return null; }, setItem() {} };
  let nextTimer = 0;
  const context = {
    console, document, location, URL, URLSearchParams, TextEncoder, Response, Request,
    Element, HTMLMediaElement, localStorage: storage,
    MutationObserver: class { observe() {} disconnect() {} },
    GM_getValue(key, fallback) { return key === 'enableProtocolUnlock' ? protocolEnabled : fallback; },
    GM_setValue() {}, GM_addStyle() { if (failStyle) throw new Error('style unavailable'); }, GM_registerMenuCommand(name, callback) { commands.push([name, callback]); },
    setTimeout() { return ++nextTimer; }, setInterval() { return ++nextTimer; }, clearTimeout() {}, clearInterval() {},
    fetch: async () => new Response('{}'),
    history: { pushState() {}, replaceState() {} }, addEventListener() {},
    innerWidth: 1200, innerHeight: 800,
  };
  context.window = context;
  context.unsafeWindow = context;
  vm.createContext(context);
  context.Object = vm.runInNewContext('Object');
  context.HTMLMediaElement = HTMLMediaElement;
  const instrumented = source.replace(/\}\)\(\);\s*$/, 'globalThis.__bfqTest = { forcePlayerTargetQuality, getCurrentPlayerQuality };\n})();');
  const startup = vm.runInContext(instrumented, context, { timeout: 1000 });
  return { startup, commands, context, listeners };
}

for (const protocolEnabled of [true, false]) {
  test(`registers settings and starts ${protocolEnabled ? 'protocol' : 'trial'} mode`, async () => {
    const result = startScript(protocolEnabled);
    await result.startup;
    assert.equal(result.commands.length, 1);
    assert.match(result.commands[0][0], /画质设置/);
    result.commands[0][1]();
    if (protocolEnabled) {
      assert.equal(result.context.fetch.constructor.name, 'AsyncFunction');
    } else {
      assert.equal(result.context.Object.defineProperty.__bfqTrialFlagsPatched, true);
      assert.equal(result.context.Object.defineProperty({}, 'isViewToday', { value: false, configurable: true }).isViewToday, true);
    }
    let requested;
    result.context.player = {
      getSupportedQualityList: () => [{ quality: 80 }, { quality: 64 }],
      getQuality: () => ({ nowQ: 64 }),
      requestQuality: value => { requested = value; },
    };
    assert.equal(result.context.__bfqTest.getCurrentPlayerQuality(result.context.player), 64);
    assert.equal(result.context.__bfqTest.forcePlayerTargetQuality(), true);
    assert.equal(requested, 80);
  });
}

test('style injection failure does not stop trial mode or settings menu', async () => {
  const result = startScript(false, true);
  await result.startup;
  assert.equal(result.commands.length, 1);
  assert.equal(result.context.Object.defineProperty.__bfqTrialFlagsPatched, true);
});
