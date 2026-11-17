const u = document.getElementById('u');
chrome.storage.sync.get('readerUrl').then(({ readerUrl }) => { u.value = readerUrl || ''; });
document.getElementById('save').onclick = async () => {
  await chrome.storage.sync.set({ readerUrl: u.value.trim() });
  document.getElementById('ok').textContent = 'Saved.';
};
