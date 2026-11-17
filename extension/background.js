// Novel Reader for Chrome.
// Toolbar button / right-click menu:
//  - on a PDF (online, or a local file if "Allow access to file URLs" is on):
//    fetch it here and hand it to the Reader tab, which turns it into sections;
//  - on any other page: run the chapter grabber (grab.js) in the page, exactly
//    like the bookmarklet, but extensions can't be blocked by the site's CSP.
const DEFAULT_READER = 'https://aikiesan.github.io/webnovel_reader/';
const readerUrl = async () => {
  const { readerUrl: u } = await chrome.storage.sync.get('readerUrl');
  return (u && /^https?:\/\//.test(u) ? u.replace(/[?#].*$/, '').replace(/\/?$/, '/') : DEFAULT_READER);
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'read-link-pdf', title: 'Read this PDF with Novel Reader', contexts: ['link'],
      targetUrlPatterns: ['*://*/*.pdf', '*://*/*.pdf?*', '*://*/*.PDF', '*://arxiv.org/pdf/*', '*://*.arxiv.org/pdf/*', 'file:///*.pdf'] });
    chrome.contextMenus.create({ id: 'read-page', title: 'Read this page with Novel Reader', contexts: ['page', 'frame'] });
  });
});

chrome.action.onClicked.addListener((tab) => readTab(tab));
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'read-link-pdf') readPdf(info.linkUrl, tab);
  else readTab(tab);
});

const looksLikePdfUrl = (u) => /\.pdf([?#].*)?$/i.test(u) || /arxiv\.org\/pdf\//i.test(u);

async function readTab(tab) {
  const url = tab.url || '';
  if (looksLikePdfUrl(url) || url.startsWith('file://') && /\.pdf$/i.test(url)) return readPdf(url, tab);
  if (/^https?:/.test(url)) {
    // some PDFs are served without .pdf in the address: ask the server
    try {
      const head = await fetch(url, { method: 'HEAD', credentials: 'include' });
      if ((head.headers.get('content-type') || '').includes('application/pdf')) return readPdf(url, tab);
    } catch {}
    return grabPage(tab);
  }
  notify(tab, 'Novel Reader can read web pages and PDFs. This page (' + url.split(':')[0] + ':) is off limits to extensions.');
}

async function grabPage(tab) {
  const app = await readerUrl();
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: (a) => { window.__readerApp = a; }, args: [app] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['grab.js'] });
  } catch (e) {
    notify(tab, 'Could not read this page: ' + e.message);
  }
}

async function readPdf(url, tab) {
  let bytes, name;
  try {
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) throw new Error('the server answered ' + r.status);
    bytes = new Uint8Array(await r.arrayBuffer());
    if (!(bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)) throw new Error('that file is not a PDF');
    const cd = r.headers.get('content-disposition') || '';
    name = (cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i) || [])[1] || decodeURIComponent(new URL(url).pathname.split('/').pop() || 'paper.pdf');
    if (!/\.pdf$/i.test(name)) name += '.pdf';
  } catch (e) {
    const local = url.startsWith('file://');
    notify(tab, local
      ? 'To read PDFs saved on your computer, open chrome://extensions, click Details under Novel Reader and turn on "Allow access to file URLs".'
      : 'Could not download the PDF: ' + e.message);
    return;
  }
  const app = await readerUrl();
  const t = await chrome.tabs.create({ url: app + '?import=pdf', index: tab ? tab.index + 1 : undefined });
  await waitForLoad(t.id);
  // base64 travels safely through executeScript; chunked to avoid giant string concatenation
  let b64 = '';
  for (let i = 0; i < bytes.length; i += 0x8000) b64 += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  b64 = btoa(b64);
  await chrome.scripting.executeScript({
    target: { tabId: t.id },
    args: [b64, name],
    func: async (data, fname) => {
      // wait until the Reader says it is listening, then post the file into the page
      for (let k = 0; k < 100 && document.documentElement.dataset.readerListening !== '1'; k++) await new Promise((r) => setTimeout(r, 100));
      window.postMessage({ type: 'reader-pdf', name: fname, b64: data }, location.origin);
    },
  });
}

function waitForLoad(tabId) {
  return new Promise((res) => {
    const done = () => { chrome.tabs.onUpdated.removeListener(on); res(); };
    const on = (id, info) => { if (id === tabId && info.status === 'complete') done(); };
    chrome.tabs.onUpdated.addListener(on);
    setTimeout(done, 20000);
  });
}

async function notify(tab, text) {
  // a small message in the page if we can, otherwise the toolbar tooltip
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, args: [text], func: (t) => alert('Novel Reader: ' + t) });
  } catch {
    chrome.action.setTitle({ tabId: tab.id, title: 'Novel Reader: ' + text });
    chrome.action.setBadgeText({ tabId: tab.id, text: '!' });
  }
}
