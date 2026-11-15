# Feedback from first real test (Galaxy S25+, Chrome) — to fix next

What works: grabbing 10 chapters on novelping with the SHORT bookmarklet; floating player plays; voice quality is very good.

## Problems reported
1. **UI is laggy.** Suspects: Kokoro on WebGPU competing with page rendering; smooth-scroll highlight on every passage; `fill()` running on every message; the iframe sitting on top of a heavy page.
2. **Changing voice mid-reading nearly froze or broke playback.** Suspects: in-flight GPU job can't be cancelled; `resetAudio()` plus the silent-loop path; possible duplicate requests after epoch bump. Make voice switching cheap: finish the current passage, then switch.
3. **Floating player layout is cramped.** The ⤢/✕ buttons overlap the header icons (📚 ☰ ⚙) when expanded. Redesign the embed layout and give the overlay controls their own space.
4. **Cadence could be better.** Ideas: add real pauses between paragraphs and after dialogue lines; split chunks at sentence boundaries more naturally; try Kokoro's own `speed` instead of `playbackRate` for >1×; normalise "...", "—", system-window brackets.
5. **"Open in Reader tab" blocked by popup blocker.** Options: use a real `<a target=_blank>` link (more often allowed), tell the user to allow pop-ups for the site, or drop this path and rely on the floating player.
6. webnovel.com: SHORT bookmarklet is blocked by the site's CSP (expected). FULL single-line version is not tested on the real site yet.
