/**
 * What the video's reviewers say about the demo app (video/demo/tinyshop): each seat's own review, its arguments round
 * by round, the fixes it drafts and its re-checks. Written the way the real reviewers write (an impact sentence first,
 * then the cause, citing path:line), against the demo's real lines. `{key}` in a text becomes that finding's id.
 *
 * The plot: two reviewers find the SQL injection on their own (merged in the grouping turn), and two find the missing
 * order check; GPT-5.5 challenges Qwen's oversell race, is answered, and comes round (confirmed); Opus challenges the
 * price cache to the end (disputed, its minority report); Qwen withdraws its error-leak finding after Opus's challenge.
 */
import type { Evidence, FindingInput, ProposalInput, Stance, Confidence } from "../../core/schemas.ts";

export type Key = "sqli" | "idor" | "race" | "tokens" | "cache" | "leak";
export type Seat = "Claude" | "Codex" | "Gemini" | "Qwen";

/** The seats, as Mirador profiles, and the model each runs on (what the council labels them by). */
export const SEATS: { name: Seat; harness: string; model: { name: string; effort: string | null } }[] = [
  { name: "Claude", harness: "claude", model: { name: "Opus 5.5", effort: "high" } },
  { name: "Codex", harness: "codex", model: { name: "GPT-5.5", effort: "high" } },
  { name: "Gemini", harness: "opencode", model: { name: "Gemini 3.5 Pro", effort: null } },
  { name: "Qwen", harness: "pi", model: { name: "Qwen 3.8 Max", effort: "medium" } },
];

export type Step =
  | { ms: number; kind: "status" | "read" | "search" | "note"; text: string; path?: string }
  | { ms: number; kind: "finding"; key: Key; finding: FindingInput };

export interface Argue {
  ms: number;
  key: Key;
  stance: Stance;
  confidence: Confidence;
  text: string;
  evidence?: Evidence[];
  /** The latest argument of this seat on this finding is the one answered. */
  replyTo?: Seat;
}

const read = (path: string, ms = 1400): Step => ({ ms, kind: "read", text: `Reading ${path}`, path });
const status = (text: string, ms = 700): Step => ({ ms, kind: "status", text });
const search = (text: string, ms = 1100): Step => ({ ms, kind: "search", text });
const at = (path: string, line: number, note: string, endLine?: number, quote?: string): Evidence => ({ path, line, ...(endLine ? { endLine } : {}), ...(quote ? { quote } : {}), note });

// --- The findings ------------------------------------------------------------------------------------------------------

const SQLI_BY_OPUS: FindingInput = {
  title: "Product search is open to SQL injection",
  summary:
    "Anyone can read or change the whole database through the search box: no sign-in needed.\n\n`searchProducts` pastes the `search` query parameter straight into its SQL. A search for `' UNION SELECT id, email, password_hash FROM users --` returns every user's password hash.",
  severity: "critical",
  confidence: "high",
  category: "injection",
  evidence: [at("src/db.ts", 26, "The search term is interpolated into the SQL.", undefined, "WHERE name LIKE '%${query}%'"), at("src/server.ts", 12, "The term comes straight from the URL, before any sign-in check.")],
  recommendation: "Bind the term as a parameter: `WHERE name LIKE ?` with `%${query}%` as its value.",
};

const SQLI_BY_GPT: FindingInput = {
  title: "SQL injection in GET /products",
  summary:
    "The public products endpoint runs whatever SQL a caller puts in `?search=`.\n\nEvery other query in the app uses `?` placeholders; this one builds its string by hand.",
  severity: "critical",
  confidence: "high",
  category: "injection",
  evidence: [at("src/db.ts", 26, "Built by string interpolation.")],
  recommendation: "Use a placeholder, like the rest of the code.",
};

const IDOR_BY_OPUS: FindingInput = {
  title: "Any signed-in user can read anyone's order",
  summary:
    "A customer who changes the number in `/orders/41` sees another customer's order.\n\n`getOrder` checks that someone is signed in, then returns the order by id without checking whose it is.",
  severity: "high",
  confidence: "high",
  category: "authorization",
  evidence: [at("src/orders.ts", 7, "Loaded by id alone.", 9), at("src/server.ts", 16, "The id comes from the path.")],
  recommendation: "Load it `WHERE id = ? AND user_id = ?`, and answer 404 when it isn't the caller's.",
};

const IDOR_BY_GEMINI: FindingInput = {
  title: "Order lookup has no ownership check",
  summary: "Order ids are sequential, so walking `/orders/1`, `/orders/2`, … lists every order in the shop.\n\nNothing compares `order.user_id` with the caller.",
  severity: "high",
  confidence: "high",
  category: "authorization",
  evidence: [at("src/orders.ts", 7, "No `user_id` in the query.")],
};

const RACE_BY_QWEN: FindingInput = {
  title: "Two buyers can both get the last item",
  summary:
    "When two people check out the last mug at the same moment, both are charged and stock ends up wrong.\n\n- Both requests read `stock = 1` and pass the check.\n- Both wait on `charge()`.\n- Both write `stock = 0`: two orders, one mug.",
  severity: "high",
  confidence: "medium",
  category: "concurrency",
  evidence: [at("src/checkout.ts", 12, "The check uses a value read before the await."), at("src/checkout.ts", 17, "The write sets stock from that stale read.")],
  recommendation: "Decrement in one guarded statement, `SET stock = stock - ? WHERE id = ? AND stock >= ?`, and charge only when it changed a row.",
};

const TOKENS_BY_GEMINI: FindingInput = {
  title: "Session tokens are guessable",
  summary:
    "An attacker who sees a few tokens can predict the next ones and sign in as other customers.\n\n`newSessionToken` uses `Math.random()`, which isn't a cryptographic generator, and gives about 52 bits at best.",
  severity: "medium",
  confidence: "high",
  category: "crypto",
  evidence: [at("src/auth.ts", 9, "`Math.random()` makes the token.", undefined, "Math.random().toString(36).slice(2)")],
  recommendation: "Use `crypto.randomUUID()` or 32 bytes from `crypto.getRandomValues`.",
};

const CACHE_BY_GPT: FindingInput = {
  title: "Checkout can charge an outdated price",
  summary:
    "After a reprice, customers keep paying the old price until the server restarts.\n\nThe price cache never expires, and checkout charges the cached price even though it has just read the current one.",
  severity: "medium",
  confidence: "medium",
  category: "correctness",
  evidence: [at("src/cache.ts", 4, "A module-level map, never cleared."), at("src/checkout.ts", 14, "Charges the cached price…"), at("src/checkout.ts", 8, "…though it just read `price_cents`.")],
  recommendation: "Charge the `price_cents` checkout already reads, and drop the cache from this path.",
};

const LEAK_BY_QWEN: FindingInput = {
  title: "Errors reveal internal details",
  summary: "A failing request returns the raw error message, which can name tables, columns and file paths.\n\nThe 500 handler sends `err.message` to the client.",
  severity: "low",
  confidence: "medium",
  category: "information-disclosure",
  evidence: [at("src/server.ts", 40, "The message goes into the response.")],
  recommendation: "Log the error and return a generic message.",
};

/** Every title a finding goes by, so the runner can tell which one a finding is. */
export const TITLES: Record<string, Key> = Object.fromEntries(
  ([
    [SQLI_BY_OPUS, "sqli"], [SQLI_BY_GPT, "sqli"], [IDOR_BY_OPUS, "idor"], [IDOR_BY_GEMINI, "idor"], [RACE_BY_QWEN, "race"],
    [TOKENS_BY_GEMINI, "tokens"], [CACHE_BY_GPT, "cache"], [LEAK_BY_QWEN, "leak"],
  ] as const).map(([finding, key]) => [finding.title, key]),
);

const found = (key: Key, finding: FindingInput, ms = 900): Step => ({ ms, kind: "finding", key, finding });

// --- Each seat's own review ----------------------------------------------------------------------------------------------

export const REVIEWS: Record<Seat, Step[]> = {
  Claude: [
    status("Reading the README and the routes"),
    read("README.md", 1200),
    read("src/server.ts", 1800),
    status("Following each route to the database"),
    read("src/db.ts", 1600),
    found("sqli", SQLI_BY_OPUS, 1400),
    read("src/orders.ts", 1500),
    read("src/auth.ts", 1300),
    found("idor", IDOR_BY_OPUS, 1500),
    read("test/checkout.test.ts", 1300),
    status("Cross-checking against the tests", 1200),
  ],
  Codex: [
    search("rg -n \"db.query\" src", 900),
    read("src/db.ts", 1000),
    found("sqli", SQLI_BY_GPT, 900),
    read("src/checkout.ts", 1300),
    read("src/cache.ts", 1000),
    search("rg -n \"getPrice|price_cents\" src scripts", 900),
    found("cache", CACHE_BY_GPT, 1300),
    read("src/payments.ts", 900),
    status("Tracing the checkout path", 900),
  ],
  Gemini: [
    read("README.md", 1300),
    read("package.json", 900),
    status("Comparing the docs with the code", 900),
    read("src/auth.ts", 1600),
    found("tokens", TOKENS_BY_GEMINI, 1300),
    read("src/server.ts", 1500),
    read("src/orders.ts", 1300),
    found("idor", IDOR_BY_GEMINI, 1400),
    read("scripts/reprice.ts", 1200),
  ],
  Qwen: [
    status("Checking edge cases", 900),
    read("src/checkout.ts", 2000),
    read("src/payments.ts", 1300),
    read("test/checkout.test.ts", 1500),
    search("rg -n \"await\" src/checkout.ts", 1100),
    found("race", RACE_BY_QWEN, 1800),
    read("src/server.ts", 1700),
    found("leak", LEAK_BY_QWEN, 1500),
    read("src/errors.ts", 1100),
  ],
};

/** The grouping turn, Opus's: the reports of one problem, and why they are one. */
export const GROUPS: { key: Key; reason: string }[] = [
  { key: "sqli", reason: "Both report the interpolated search term in src/db.ts:26; one parameterized query fixes both." },
  { key: "idor", reason: "Both report that getOrder loads an order by id without checking its owner." },
];

// --- The deliberation ----------------------------------------------------------------------------------------------------

export const ROUNDS: Record<Seat, Argue[][]> = {
  Claude: [
    [
      { ms: 1600, key: "race", stance: "supports", confidence: "high", text: "Real: the `await charge()` at src/checkout.ts:15 sits between the stock check and the write, so two requests interleave there.", evidence: [at("src/checkout.ts", 15, "The await between check and write.")] },
      { ms: 1800, key: "leak", stance: "challenges", confidence: "high", text: "Not in production: src/server.ts:40 returns the message only when `NODE_ENV` isn't `production`, and says \"Internal error\" otherwise.", evidence: [at("src/server.ts", 40, "Production gets a generic message.")] },
      { ms: 1800, key: "cache", stance: "challenges", confidence: "medium", text: "This is the documented design: README.md:20 says prices change only through reprice.ts during a deploy, and the deploy restarts the server, which empties the cache.", evidence: [at("README.md", 20, "Prices change only at deploy.", 21)] },
      { ms: 1200, key: "tokens", stance: "supports", confidence: "high", text: "Agreed: `Math.random()` at src/auth.ts:9 is not meant for secrets." },
    ],
    [],
    [
      { ms: 2200, key: "cache", stance: "challenges", confidence: "medium", text: "I still read it as an operations rule, not a code bug: the README makes the restart part of every reprice. A TTL would hide a broken deploy rather than fix one.", replyTo: "Codex", evidence: [at("README.md", 20, "The rule the deploy follows.", 21)] },
    ],
  ],
  Codex: [
    [
      { ms: 1300, key: "idor", stance: "supports", confidence: "high", text: "Confirmed: src/orders.ts:7 has no `user_id` in the query, and ids are sequential." },
      { ms: 1500, key: "race", stance: "challenges", confidence: "medium", text: "I doubt it: `bun:sqlite` is synchronous and Bun runs one request at a time, so two checkouts can't interleave their reads and writes." },
      { ms: 1100, key: "tokens", stance: "supports", confidence: "high", text: "Agreed, and the tokens never expire either." },
    ],
    [
      { ms: 2000, key: "cache", stance: "supports", confidence: "high", text: "Nothing in the code enforces the README: reprice.ts writes to the live database and doesn't restart anything. Checkout reads the new `price_cents` at src/checkout.ts:8 and then charges the cached one at :14.", replyTo: "Claude", evidence: [at("scripts/reprice.ts", 17, "Writes prices without a restart.", 19), at("src/checkout.ts", 14, "Charges the cached price.")] },
    ],
    [
      { ms: 1800, key: "race", stance: "supports", confidence: "high", text: "That answers my objection: the await at src/checkout.ts:15 does split the check from the write. I now back {race}.", replyTo: "Qwen", evidence: [at("src/checkout.ts", 15, "Where the requests interleave.")] },
    ],
  ],
  Gemini: [
    [
      { ms: 1400, key: "sqli", stance: "supports", confidence: "high", text: "Reproduced by reading: `search=%' OR 1=1 --` at src/db.ts:26 lists every product, and a UNION reads the users table." },
      { ms: 1500, key: "race", stance: "supports", confidence: "medium", text: "Plausible, and the tests only run checkouts one after another (test/checkout.test.ts:15), so nothing would catch it." },
      { ms: 1400, key: "cache", stance: "supports", confidence: "medium", text: "Backed: the cache has no expiry and no way to clear it (src/cache.ts:4)." },
    ],
    [
      { ms: 1500, key: "leak", stance: "uncertain", confidence: "low", text: "Only outside production, as Opus 5.5 says; whether that matters depends on how it is deployed." },
    ],
    [],
  ],
  Qwen: [
    [
      { ms: 1500, key: "sqli", stance: "supports", confidence: "high", text: "Agreed: the only query in the app built by hand." },
      { ms: 1500, key: "idor", stance: "supports", confidence: "high", text: "Agreed: the 401 at src/orders.ts:6 is the only check." },
      { ms: 1300, key: "tokens", stance: "supports", confidence: "high", text: "Agreed." },
      { ms: 1400, key: "cache", stance: "uncertain", confidence: "low", text: "Depends on whether the deploy always restarts; I can't see the deploy from here." },
    ],
    [
      { ms: 2300, key: "race", stance: "supports", confidence: "high", text: "They can interleave: Bun runs one request at a time only until it awaits. At src/checkout.ts:15 the first request yields, the second reads the same stock at :8 and passes the check at :12.", replyTo: "Codex", evidence: [at("src/checkout.ts", 15, "The first request yields here."), at("src/checkout.ts", 12, "The second passes the same check.")] },
      { ms: 1500, key: "leak", stance: "challenges", confidence: "high", text: "Fair point: production gets \"Internal error\" (src/server.ts:40). I withdraw {leak}.", replyTo: "Claude" },
    ],
    [
      { ms: 1700, key: "cache", stance: "supports", confidence: "medium", text: "Now backed: reprice.ts:17 commits to the live database with no restart, so the README's rule depends on people remembering it." },
    ],
  ],
};

// --- Fixes and re-checks -------------------------------------------------------------------------------------------------

export const PROPOSALS: Record<Key, Omit<ProposalInput, "findingId">> = {
  sqli: {
    summary: "Bind the search term as a parameter.",
    steps: ["In `searchProducts`, query `WHERE name LIKE ?` and pass `%${query}%` as its value.", "Add a test that searches for `' OR 1=1 --` and gets no rows."],
    files: ["src/db.ts", "tests/search.test.ts"],
    verification: "The injection test returns nothing, and a normal search still matches.",
  },
  idor: {
    summary: "Load an order only for its owner.",
    steps: ["Query `WHERE id = ? AND user_id = ?` in `getOrder`.", "Answer 404 for someone else's order, so ids don't reveal which orders exist."],
    files: ["src/orders.ts"],
    verification: "A second user asking for the first user's order gets 404.",
  },
  race: {
    summary: "Take the stock in one guarded statement before charging.",
    steps: ["Run `UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?`; answer 409 when it changes no row.", "Charge only after that, and put the stock back if the charge fails."],
    files: ["src/checkout.ts"],
    verification: "Two concurrent checkouts of the last item: one succeeds, one gets 409, stock is 0.",
    risks: "A failed charge must put the stock back.",
  },
  tokens: {
    summary: "Make session tokens with a cryptographic generator.",
    steps: ["Return `crypto.randomUUID()` (or 32 random bytes as hex) from `newSessionToken`."],
    files: ["src/auth.ts"],
    verification: "Tokens are 122 bits or more of crypto randomness.",
  },
  cache: {
    summary: "Charge the price checkout already reads.",
    steps: ["Use `product.price_cents` for the total and drop `getPrice` from checkout."],
    files: ["src/checkout.ts"],
    verification: "After a reprice without a restart, checkout charges the new price.",
    risks: "Opus 5.5 holds this is an operations rule; the change is small either way.",
  },
  leak: { summary: "Withdrawn.", steps: ["Nothing."], files: [], verification: "Nothing." },
};

export const CHECKS: Record<Key, { text: string; evidence: Evidence[] }> = {
  sqli: { text: "Verified: the search term is now bound as a parameter, so a quote in it no longer reaches the SQL.", evidence: [at("src/db.ts", 26, "Parameterized now.")] },
  idor: { text: "Verified: `getOrder` now matches the order's `user_id` with the caller, and someone else's order is not found.", evidence: [at("src/orders.ts", 7, "Scoped to the caller.")] },
  race: { text: "Verified: the stock is taken in one guarded update before the charge, so two buyers can no longer both get the last item.", evidence: [at("src/checkout.ts", 12, "The guarded update.")] },
  tokens: { text: "Verified: tokens now come from the crypto generator.", evidence: [at("src/auth.ts", 9, "crypto randomness.")] },
  cache: { text: "Verified: checkout charges the price it reads.", evidence: [at("src/checkout.ts", 14, "The current price.")] },
  leak: { text: "Nothing to check.", evidence: [] },
};
