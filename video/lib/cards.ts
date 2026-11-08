/** Draws the title and end cards, and the thumbnail, as 2560 x 1440 stills into video/out/cards. `bun video/lib/cards.ts` */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const out = join(import.meta.dir, "..", "out", "cards");
mkdirSync(out, { recursive: true });
const logo = readFileSync(join(import.meta.dir, "..", "..", "icon.svg"), "utf8").replace(/width="1024" height="1024"/, 'width="190" height="190"');

const style = `
body { margin: 0; width: 1536px; height: 864px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 22px;
  background: radial-gradient(ellipse at 50% 40%, #1d2b4a 0%, #0c1220 72%); color: #f4f1ea; }
.big { font: 600 84px/1.1 "Iowan Old Style", Palatino, Georgia, serif; letter-spacing: -0.5px; }
.big em { color: #ffd479; font-style: normal; }
.small { font: 400 30px/1.4 -apple-system, "Helvetica Neue", sans-serif; color: #c3cce0; }
.mono { font: 400 24px/1.4 "SF Mono", Menlo, monospace; color: #8fa3c8; margin-top: 26px; }
.thumb .big { font-size: 112px; }
.thumb .small { font-size: 40px; color: #ffd479; }
`;

const name = `<div class="big">Spectra <em>Council</em></div>`;
const cards = {
  title: `${logo}${name}<div class="small">Several AI agents review your code, and argue it out</div>`,
  end: `${logo}${name}<div class="small">A Mirador plugin · free and open source</div><div class="mono">github.com/akanto/spectra-council</div>`,
  thumbnail: `<div class="thumb" style="display:contents">${logo}${name}<div class="small">Four AI reviewers. One verdict.</div></div>`,
};

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1536, height: 864 }, deviceScaleFactor: 5 / 3 });
for (const [card, html] of Object.entries(cards)) {
  await page.setContent(`<style>${style}</style>${html}`);
  await page.screenshot({ path: join(out, `${card}.jpg`), type: "jpeg", quality: 95 });
}
await browser.close();
console.log("cards in", out);
