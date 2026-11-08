/* Per-viewer colour themes. Stored only in this browser; drawings keep their colour names, each viewer sees them in their own palette. */
(() => {
  const LIGHT = { bg: "#f6f7f4", dot: "#c9cfc4", fg: "#1d2420", muted: "#67706a", panel: "#ffffff", line: "#dde2da", hover: "#eef1ec", accent: "#2f6f5e", "accent-fg": "#ffffff", sel: "#2f6f5e",
    ink: "#1d2420", red: "#d2462f", blue: "#2c63c9", green: "#2f8a4a", orange: "#e08a1e", violet: "#7a4cc2",
    "note-yellow": "#fbe9a0", "note-pink": "#f8c9d2", "note-blue": "#c6e0f5", "note-green": "#cdeccb", "note-fg": "#2a2a22",
    shadow: "0 6px 24px rgba(30,40,34,.14), 0 1px 3px rgba(30,40,34,.08)" };
  const DARK = { bg: "#171b19", dot: "#303733", fg: "#e7ebe6", muted: "#98a19a", panel: "#222825", line: "#353d38", hover: "#2c332f", accent: "#6cc3a6", "accent-fg": "#0f1a15", sel: "#6cc3a6",
    ink: "#eef1ec", red: "#ff7a62", blue: "#79a6ff", green: "#6ed38a", orange: "#ffb04d", violet: "#b996ff",
    "note-yellow": "#e9d27c", "note-pink": "#e6a7b4", "note-blue": "#9fc4e3", "note-green": "#a9d6a6", "note-fg": "#1d1d17",
    shadow: "0 6px 24px rgba(0,0,0,.45), 0 1px 3px rgba(0,0,0,.3)" };
  const THEMES = [
    { id: "system", name: "Как в системе" },
    { id: "light", name: "Светлая", base: "light" },
    { id: "dark", name: "Тёмная", base: "dark" },
    { id: "paper", name: "Бумага", base: "light", t: { bg: "#f2ece0", dot: "#d9cfbc", fg: "#2b2620", muted: "#73695b", panel: "#fbf8f2", line: "#e3dac9", hover: "#ece4d4", accent: "#8c5a2b", sel: "#8c5a2b", ink: "#2b2620" } },
    { id: "lavender", name: "Лаванда", base: "light", t: { bg: "#f4f1fa", dot: "#d5cde6", fg: "#28213a", muted: "#6c6482", panel: "#ffffff", line: "#e2dbef", hover: "#ece6f7", accent: "#6b46c1", sel: "#6b46c1", ink: "#28213a" } },
    { id: "mint", name: "Мята", base: "light", t: { bg: "#ecf6f1", dot: "#c3dccf", fg: "#16302a", muted: "#58706a", panel: "#fbfffd", line: "#d3e7dd", hover: "#e2f0e9", accent: "#12806a", sel: "#12806a", ink: "#16302a" } },
    { id: "ocean", name: "Океан", base: "dark", t: { bg: "#0e1a28", dot: "#21344a", fg: "#e3edf7", muted: "#8ea3b8", panel: "#15263a", line: "#24384f", hover: "#1c3048", accent: "#4cc2e0", "accent-fg": "#06202a", sel: "#4cc2e0", ink: "#eaf2fb" } },
    { id: "sunset", name: "Закат", base: "dark", t: { bg: "#211a1e", dot: "#3a2e34", fg: "#f6e9e2", muted: "#b39c95", panel: "#2c2228", line: "#40333a", hover: "#362a30", accent: "#ff8a5c", "accent-fg": "#2a1208", sel: "#ff8a5c", ink: "#f8eee8" } },
    { id: "chalk", name: "Школьная доска", base: "dark", t: { bg: "#22372c", dot: "#2f4a3b", fg: "#eef3ea", muted: "#a6b8aa", panel: "#2a4234", line: "#3a5646", hover: "#33503f", accent: "#f2d16b", "accent-fg": "#2a2306", sel: "#f2d16b", ink: "#f4f6ef" } },
    { id: "contrast", name: "Контраст", base: "light", t: { bg: "#ffffff", dot: "#b0b0b0", fg: "#000000", muted: "#333333", panel: "#ffffff", line: "#000000", hover: "#e6e6e6", accent: "#0038d9", sel: "#0038d9", ink: "#000000", red: "#c4000f", blue: "#0038d9", green: "#00701c", orange: "#b35900", violet: "#5b00b8" } },
  ];
  const HEX = /^#[0-9a-f]{6}$/i;
  const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const hex = a => "#" + a.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
  const mix = (a, b, t) => { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v + (y[i] - v) * t)); };
  const lum = h => { const [r, g, b] = rgb(h).map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return .2126 * r + .7152 * g + .0722 * b; };
  const systemDark = () => matchMedia("(prefers-color-scheme: dark)").matches;
  function tokensFor(s) {
    if (!s || s.id === "system") return { ...(systemDark() ? DARK : LIGHT), _dark: systemDark() };
    if (s.id === "custom") {
      const bg = HEX.test(s.bg) ? s.bg : "#f6f7f4", accent = HEX.test(s.accent) ? s.accent : "#2f6f5e";
      const dark = lum(bg) < .2, fg = dark ? "#eef1ec" : "#1d2420";
      return { ...(dark ? DARK : LIGHT), bg, fg, ink: fg, accent, sel: accent, "accent-fg": lum(accent) > .4 ? "#111111" : "#ffffff",
        dot: mix(bg, fg, .17), muted: mix(bg, fg, .58), line: mix(bg, fg, .14), hover: mix(bg, fg, .07),
        panel: dark ? mix(bg, "#ffffff", .06) : mix(bg, "#ffffff", .75), _dark: dark };
    }
    const th = THEMES.find(t => t.id === s.id) || THEMES[0];
    if (!th.base) return tokensFor({ id: "system" });
    return { ...(th.base === "dark" ? DARK : LIGHT), ...(th.t || {}), _dark: th.base === "dark" };
  }
  function apply(s) {
    const root = document.documentElement;
    for (const k of Object.keys(LIGHT)) root.style.removeProperty("--" + k);
    if (s && s.id !== "system") {
      const t = tokensFor(s);
      for (const k of Object.keys(LIGHT)) root.style.setProperty("--" + k, t[k]);
      root.style.colorScheme = t._dark ? "dark" : "light";
    } else root.style.colorScheme = "";
  }
  let saved = { id: "system" };
  try { const v = JSON.parse(localStorage.getItem("board.theme") || "null"); if (v && typeof v.id === "string") saved = v; } catch {}
  window.boardTheme = { THEMES, tokensFor, apply, saved };
  apply(saved);
})();
