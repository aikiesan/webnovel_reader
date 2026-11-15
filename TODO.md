# Feedback from first real test (Galaxy S25+, Chrome)

What works: grabbing 10 chapters on novelping with the SHORT bookmarklet; floating player plays; voice quality is very good.

## Status after fix round 1 (needs re-test on the phone)
1. UI lag: **mitigated.** The voice engine now pauses for ~1.5 s whenever you touch or scroll (only if enough audio is ready). While just listening it stops generating once ~10 min is ready, so the GPU rests. Scrolling only moves when the highlight leaves the middle of the screen. Panels open before their lists are built.
2. Voice change mid-reading: **fixed.** The current passage finishes in the old voice and the next one uses the new voice. Playback is no longer reset, and the playing audio is no longer freed while it is still playing.
3. Floating player layout: **fixed.** ▲/✕ now sit in their own strip above the player, not on top of the app.
4. Cadence: **improved.** A passage never spans two paragraphs. Pauses: title 0.8 s, paragraph 0.45 s, dialogue 0.38 s, mid-paragraph 0.14 s. Kokoro's own silence is trimmed so gaps are consistent. Normalised: dashes → pause, "!!!" → "!", "AAAAAH" → "Aaah", SHOUTING is no longer spelled out letter by letter, "Lv." → "Level", "x2" → "times 2".
5. "Open in Reader tab" pop-up blocked: **fixed.** It is now a real link that carries the chapters inside the address (#import=…, gzip). Nothing is sent to a server.
6. webnovel.com FULL bookmarklet: still untested on the real site.
7. Menus laggy: see 1.
8. Background playback: **implemented.** Every generated passage is saved on the phone as Ogg/Opus (~20 kbps ≈ 9 MB/hour, IndexedDB). The ⬇ button prepares This chapter / Next 3 / 5 / 10 while the screen is on (keeps it awake) and shows progress. Background playback then only plays saved files. Audio for chapters more than one behind is deleted automatically.

## To check on the phone
- Prepare 3 chapters, lock the phone: does it play through all 3?
- Same test inside the floating player (iframe) vs the Reader tab.
- Is the lag acceptable now while it generates?
