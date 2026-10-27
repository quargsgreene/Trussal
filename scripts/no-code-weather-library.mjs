// Builds examples/no-code/weather-library.json, the weather snippets every
// room's No Code library starts with (src/no-code.js). The flows are written
// here as source text and land in the JSON as strings, so edit them here and
// regenerate:
//
//   node scripts/no-code-weather-library.mjs examples/no-code/weather-library.json
//
// What a flow returns becomes a paragraph of the personal program, and
// strudel-voice.js wraps each blank-line-separated paragraph as ONE voice,
// `$: (body).gain(…)`. So every css() statement a flow emits is its own
// paragraph, and none carries a // comment: a comment would swallow the
// wrapper's closing paren, and two labels in one paragraph end up nested in
// its parens — either way the whole room program fails to parse.
import { writeFileSync } from 'node:fs';

const svg = (bg, label, extra = '') => `data:image/svg+xml;base64,${Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="10" fill="${bg}"/>${extra}<text x="32" y="56" font-family="sans-serif" font-size="11" text-anchor="middle" fill="#fff">${label}</text></svg>`,
).toString('base64')}`;
const sun = '<circle cx="32" cy="26" r="11" fill="#ffd54a"/>';
const cloud = '<ellipse cx="26" cy="28" rx="12" ry="8" fill="#eceff1"/><ellipse cx="38" cy="26" rx="11" ry="9" fill="#eceff1"/>';
const pin = '<path d="M32 10a11 11 0 0 1 11 11c0 9-11 20-11 20S21 30 21 21a11 11 0 0 1 11-11z" fill="#fff"/><circle cx="32" cy="21" r="4" fill="#37474f"/>';
const mars = '<circle cx="32" cy="26" r="15" fill="#d9663b"/><circle cx="26" cy="21" r="3" fill="#b5502d"/><circle cx="37" cy="31" r="4" fill="#b5502d"/>';
const bars = '<rect x="12" y="20" width="6" height="16" fill="#ffd54a"/><rect x="21" y="16" width="6" height="20" fill="#ffd54a"/><rect x="30" y="22" width="6" height="14" fill="#90caf9"/><rect x="39" y="26" width="6" height="10" fill="#90caf9"/><rect x="48" y="18" width="6" height="18" fill="#b39ddb"/>';

// Shared by every Earth flow: WMO weather code (Open-Meteo) → a palette, and
// a palette → CSS Cycles statements. Kept as source text so each flow is
// self-contained in the library file.
const EARTH_HELPERS = String.raw`
const PALETTES = {
  clear:   { bg: "#fff4d6", fg: "#2a1e05", accent: "#c98a00", panel: "#ffe08a" },
  partly:  { bg: "#e8eef5", fg: "#1c2733", accent: "#b7791f", panel: "#cfd9e4" },
  overcast:{ bg: "#c9ced3", fg: "#1e2328", accent: "#56616b", panel: "#b3b9bf" },
  fog:     { bg: "#dfe3e2", fg: "#2f3533", accent: "#6b7572", panel: "#eef0ef" },
  rain:    { bg: "#2f4256", fg: "#e8f1fb", accent: "#6fa8dc", panel: "#3d556e" },
  snow:    { bg: "#f4f8fc", fg: "#10243a", accent: "#2f78b0", panel: "#ffffff" },
  storm:   { bg: "#1d1530", fg: "#f1ecff", accent: "#ffe066", panel: "#2c2148" },
};
const kindOf = (code) =>
  code <= 1 ? "clear" : code === 2 ? "partly" : code === 3 ? "overcast"
  : code === 45 || code === 48 ? "fog"
  : (code >= 71 && code <= 77) || code === 85 || code === 86 ? "snow"
  : code >= 95 ? "storm" : "rain";
const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const mix = (a, b, t) => "#" + hex(a).map((v, i) => Math.round(v + (hex(b)[i] - v) * t).toString(16).padStart(2, "0")).join("");
// Night dims the sky; cold pulls the accent toward ice, heat toward ember.
function paletteFor(code, isDay, tempC) {
  const kind = kindOf(code);
  let p = { ...PALETTES[kind] };
  if (!isDay) {
    p = kind === "clear"
      ? { bg: "#0b1633", fg: "#e6ecff", accent: "#7aa2ff", panel: "#16244d" }
      : { bg: mix(p.bg, "#0b1020", 0.6), fg: "#e8ecf4", accent: p.accent, panel: mix(p.panel, "#0b1020", 0.5) };
  }
  if (tempC <= 0) p.accent = mix(p.accent, "#5fb4ff", 0.5);
  else if (tempC >= 30) p.accent = mix(p.accent, "#ff6a3d", 0.5);
  return { kind, ...p };
}
// The window's inner panels, cards and buttons all paint from the theme's two
// anchors (theme-context.js), so the body takes the palette by reassigning
// them. Plain declarations rather than a patterned chain: custom properties
// are not chainable, so they hold the first palette while the frame moves.
const anchors = (p) => "$: css(\x60.ts-window-body { --trussal-primary: " + p.bg + "; --trussal-secondary: " + p.fg + " }\x60)";
// One value, or a "<a b …>" sequence that moves on once per cycle.
const seq = (values) => (new Set(values).size === 1 ? values[0] : "<" + values.join(" ") + ">");
function themeCss(ps, { fast = 1 } = {}) {
  const pick = (k) => seq(ps.map((p) => p[k]));
  const kinds = new Set(ps.map((p) => p.kind));
  // Rain shimmers the borders; a storm flashes them.
  let edge = pick("accent");
  if (ps.length === 1 && kinds.has("rain")) edge = "<" + ps[0].accent + " " + ps[0].panel + ">*4";
  if (ps.length === 1 && kinds.has("storm")) edge = "<" + ps[0].panel + " " + ps[0].panel + " " + ps[0].panel + " " + ps[0].accent + ">*2";
  const speed = fast > 1 ? ".fast(" + fast + ")" : "";
  return [
    anchors(ps[0]),
    "$: css(\x60.ts-window { transition: background-color 2s, color 2s }\x60).backgroundColor(\"" + pick("bg") + "\").color(\"" + pick("fg") + "\").borderColor(\"" + edge + "\")" + speed,
    "$: css(\x60.ts-window .ts-header { transition: background-color 2s }\x60).backgroundColor(\"" + pick("panel") + "\").color(\"" + pick("fg") + "\")" + speed,
    "$: css(\x60.ts-window .ts-btn { transition: border-color 1s }\x60).borderColor(\"" + edge + "\")" + speed,
  ].join("\n\n");
}
function place(operand) {
  const [lat, lon] = String(operand.value).split(",").map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error("operand 1 must be a place (latitude,longitude)");
  return { lat, lon };
}
`;

const weatherTheme = `${EARTH_HELPERS}
const { lat, lon } = place(operands[0]);
const w = await ctx.fetchJson("https://api.open-meteo.com/v1/forecast?latitude=" + lat + "&longitude=" + lon
  + "&current=temperature_2m,weather_code,wind_speed_10m,is_day");
const now = w.current;
const p = paletteFor(now.weather_code, now.is_day === 1, now.temperature_2m);
// Wind speeds the shimmer up: calm, breezy (> 25 km/h), gale (> 50 km/h).
const fast = now.wind_speed_10m > 50 ? 4 : now.wind_speed_10m > 25 ? 2 : 1;
return { language: "css", source: themeCss([p], { fast }) };
`;

const forecastTheme = `${EARTH_HELPERS}
const { lat, lon } = place(operands[0]);
const w = await ctx.fetchJson("https://api.open-meteo.com/v1/forecast?latitude=" + lat + "&longitude=" + lon
  + "&hourly=weather_code,is_day,temperature_2m&forecast_hours=8");
const h = w.hourly;
const ps = h.weather_code.map((code, i) => paletteFor(code, h.is_day[i] === 1, h.temperature_2m[i]));
return { language: "css", source: themeCss(ps) };
`;

// Curiosity's REMS station in Gale crater, via NASA's public feed (newest sol
// first). Mars sunsets are blue — fine dust scatters red light away from the
// sun — so twilight gets its own palette.
const marsTheme = String.raw`
const feed = await ctx.fetchJson("https://mars.nasa.gov/rss/api/?feed=weather&category=msl&feedtype=json");
const sol = (feed.soles || []).find((s) => s.max_temp !== "--" && s.min_temp !== "--");
if (!sol) throw new Error("the Curiosity feed has no recent sol with temperatures");
const hi = Number(sol.max_temp), ls = Number(sol.ls);
// Local mean solar time at Gale (137.4°E), from the Mars Sol Date.
const msd = (Date.now() / 86400000 + 2440587.5 + 69.184 / 86400 - 2405522.0028779) / 1.0274912517;
const lmst = ((24 * msd + 137.4 / 15) % 24 + 24) % 24;
const hours = (t) => { const [a, b] = String(t).split(":").map(Number); return a + b / 60; };
const rise = hours(sol.sunrise || "06:00"), set = hours(sol.sunset || "18:00");
const twilight = Math.abs(lmst - rise) < 0.75 || Math.abs(lmst - set) < 0.75;
const day = lmst > rise && lmst < set;
const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const mix = (a, b, t) => "#" + hex(a).map((v, i) => Math.round(v + (hex(b)[i] - v) * t).toString(16).padStart(2, "0")).join("");
// Warmer sols run butterscotch, colder ones deep rust.
const warmth = Math.max(0, Math.min(1, (hi + 40) / 45));
let p = twilight ? { bg: "#24344f", fg: "#eaf2ff", accent: "#7fb3e8", panel: "#2f4566" }
  : day ? { bg: mix("#9c3d22", "#e3a868", warmth), fg: "#1f0d05", accent: "#5a1d0c", panel: mix("#b5502d", "#f0c088", warmth) }
  : { bg: "#1a0d0a", fg: "#f3d9c8", accent: "#c4602f", panel: "#2b1610" };
if (day && warmth < 0.35) p.fg = "#fff1e6";
// Ls 180–360 is the southern spring and summer: dust-storm season, so the
// borders drift through haze.
const dusty = ls >= 180 || /dust|cloud/i.test(sol.atmo_opacity || "");
const edge = dusty ? "<" + p.accent + " " + mix(p.accent, "#d9a066", 0.6) + ">/2" : p.accent;
const css = [
  "$: css(\x60.ts-window-body { --trussal-primary: " + p.bg + "; --trussal-secondary: " + p.fg + " }\x60)",
  "$: css(\x60.ts-window { transition: background-color 3s, color 3s }\x60).backgroundColor(\"" + p.bg + "\").color(\"" + p.fg + "\").borderColor(\"" + edge + "\")",
  "$: css(\x60.ts-window .ts-header { transition: background-color 3s }\x60).backgroundColor(\"" + p.panel + "\").color(\"" + p.fg + "\")",
  "$: css(\x60.ts-window .ts-btn { transition: border-color 1s }\x60).borderColor(\"" + edge + "\")",
].join("\n\n");
return { language: "css", source: css };
`;

const PLACES = [
  ['Reykjavík', '64.15,-21.94', '#455a64'],
  ['London', '51.51,-0.13', '#546e7a'],
  ['New York', '40.71,-74.01', '#37474f'],
  ['Phoenix', '33.45,-112.07', '#bf6a2a'],
  ['Tokyo', '35.68,139.69', '#ad1457'],
  ['Singapore', '1.29,103.85', '#00796b'],
];

const snippets = [
  {
    name: 'Weather theme',
    type: 'flow',
    language: 'javascript',
    medium: 'css',
    operands: 1,
    description: 'Drop a place in operand 1. Reads the current weather there (Open-Meteo) and themes the Studio windows to match: sunny, cloudy, fog, rain shimmer, snow, storm flashes; night dims it, wind speeds it up.',
    thumbnailImage: svg('#1565c0', 'WEATHER', sun + cloud),
    source: weatherTheme.trim(),
  },
  {
    name: 'Forecast theme',
    type: 'flow',
    language: 'javascript',
    medium: 'css',
    operands: 1,
    description: 'Drop a place in operand 1. Plays the next 8 hours of forecast (Open-Meteo) as a theme that moves to the next hour every cycle.',
    thumbnailImage: svg('#283593', 'FORECAST', bars),
    source: forecastTheme.trim(),
  },
  {
    name: 'Mars weather theme',
    type: 'flow',
    language: 'javascript',
    medium: 'css',
    operands: 0,
    description: 'Themes the Studio windows from Curiosity\'s latest sol in Gale crater (NASA REMS feed): rust to butterscotch with the temperature, a blue Martian sunset at twilight, drifting dust in storm season.',
    thumbnailImage: svg('#3e1a10', 'MARS', mars),
    source: marsTheme.trim(),
  },
  ...PLACES.map(([name, coords, color]) => ({
    name,
    type: 'pattern',
    language: 'text',
    medium: 'data',
    operands: 0,
    description: `A place (${coords}) for a weather snippet's operand. On a line of its own it only writes its coordinates as text.`,
    thumbnailImage: svg(color, name.toUpperCase().slice(0, 9), pin),
    source: coords,
  })),
];

writeFileSync(process.argv[2], `${JSON.stringify({ snippets }, null, 2)}\n`);
