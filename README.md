# Novel Reader

Listen to web novels with natural neural voices (Kokoro-82M) that run **on your phone** — free, private, and offline after the first load.

- **EPUB/TXT import**: 📚 → Import.
- **webnovel.com**: 📚 → "Webnovel.com button" → set up the bookmarklet once, then run it on any chapter page. It grabs that chapter + the next ones your account can read, then either plays them in a **floating player** on top of the page or opens them in the reader tab.
- **Listen with the screen off**: tap ⬇ and prepare the next chapters while the screen is on. The voice is saved on the phone (~9 MB/hour), so playback keeps going when Chrome is minimised or the phone is locked.
- Lock screen / headphone buttons skip back/forward one passage. Speed up to 2.5× with pitch preserved.
- Books are stored only in your browser (IndexedDB). Nothing is uploaded.

First launch downloads the ~330 MB voice model (Wi-Fi recommended). Best on Chrome for Android (WebGPU).

Testing without the model: open `?mock` for a fake voice.
