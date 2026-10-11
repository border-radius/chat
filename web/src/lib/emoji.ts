// The emoji the picker offers (§20.4), for the composer and for reactions. Reactions are limited to exactly these:
// pb_hooks/lib/emoji.js holds the same set for the server, and tests/unit/lib/emoji.test.ts fails if they drift.
// Emoji 12 and older, so every current system font has them. No names: buttons are read out by the emoji itself.

export interface EmojiCategory {
  name: string;
  /** Shown on the category's tab. */
  icon: string;
  emoji: readonly string[];
}

const list = (s: string) => s.split(" ");

export const CATEGORIES: readonly EmojiCategory[] = [
  {
    name: "Smileys",
    icon: "😀",
    emoji: list(
      "😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😙 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 😌 " +
        "😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🥵 🥶 🥴 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 " +
        "😓 😩 😫 🥱 😤 😡 😠 🤬 😈 👿 💀 💩 🤡 👻 👽 🤖 😺 😸 😹 😻 😼 😽 🙀 😿 😾 🙈 🙉 🙊",
    ),
  },
  {
    name: "People",
    icon: "👋",
    emoji: list(
      "👋 🤚 🖐️ ✋ 🖖 👌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 👐 🤲 🤝 🙏 ✍️ 💅 💪 🧠 👀 👅 👄 " +
        "👶 🧒 👦 👧 🧑 👨 👩 🧓 👴 👵 🙋 🙇 🤦 🤷 💁 🙆 🙅 🕺 💃 👯 🏃 🚶",
    ),
  },
  {
    name: "Nature",
    icon: "🐶",
    emoji: list(
      "🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐧 🐦 🐤 🦆 🦅 🦉 🦇 🐺 🐗 🐴 🦄 🐝 🐛 🦋 🐌 🐞 🐜 🐢 🐍 🦎 🐙 🦑 " +
        "🦀 🐠 🐟 🐬 🐳 🦈 🐊 🦒 🐘 🦔 🐾 🌵 🎄 🌲 🌳 🌴 🌱 🌿 🍀 🍁 🍂 🍃 🌷 🌹 🌺 🌸 🌼 🌻 🌞 🌝 🌚 🌙 🌎 🪐 ☀️ ⛅ " +
        "❄️ ☃️ ⛄ 🌈 🌊 💧 ☔",
    ),
  },
  {
    name: "Food",
    icon: "🍕",
    emoji: list(
      "🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🍈 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🥑 🍆 🥔 🥕 🌽 🌶️ 🥒 🥦 🧄 🧅 🍄 🥜 🍞 🥐 🥖 🥨 🥯 🥞 🧇 " +
        "🧀 🍖 🍗 🥩 🥓 🍔 🍟 🍕 🌭 🥪 🌮 🌯 🥗 🍝 🍜 🍲 🍛 🍣 🍱 🥟 🍤 🍙 🍚 🍘 🍥 🍦 🍧 🍨 🍩 🍪 🎂 🍰 🧁 🥧 🍫 🍬 " +
        "🍭 🍮 🍯 🍼 ☕ 🍵 🧃 🥤 🍶 🍺 🍻 🥂 🍷 🥃 🍸 🍹 🍾 🧊",
    ),
  },
  {
    name: "Activities",
    icon: "⚽",
    emoji: list(
      "⚽ 🏀 🏈 ⚾ 🥎 🎾 🏐 🏉 🥏 🎱 🏓 🏸 🏒 🥅 ⛳ 🏹 🎣 🥊 🥋 🎽 🛹 ⛸️ 🎿 🏂 🏆 🥇 🥈 🥉 🏅 🎖️ 🎫 🎪 🎭 🎨 🎬 🎤 " +
        "🎧 🎼 🎹 🥁 🎷 🎺 🎸 🎻 🎲 ♟️ 🎯 🎳 🎮 🎰 🧩 🎉 🎊 🎈 🎁 🎀 🎃 🎆 🎇 🧨",
    ),
  },
  {
    name: "Travel",
    icon: "🚗",
    emoji: list(
      "🚗 🚕 🚙 🚌 🏎️ 🚓 🚑 🚒 🚚 🚜 🛵 🏍️ 🚲 🛴 🚨 🚃 🚄 🚂 ✈️ 🛫 🛬 🚀 🛸 🚁 ⛵ 🚤 🚢 ⚓ 🗺️ 🗽 🗼 🏰 🏯 🏟️ 🎡 🎢 " +
        "🎠 ⛲ 🏖️ 🏝️ 🏜️ 🌋 ⛰️ 🏔️ 🏕️ 🏠 🏡 🏢 🏥 🏦 🏨 🏫 🏛️ ⛪ 🕌 🌃 🌆 🌇 🌉 🌌",
    ),
  },
  {
    name: "Objects",
    icon: "💡",
    emoji: list(
      "⌚ 📱 💻 ⌨️ 🖥️ 🖨️ 🖱️ 💾 💿 📷 📸 🎥 📞 ☎️ 📺 📻 🎙️ ⏰ ⏳ 🔋 🔌 💡 🔦 🕯️ 💸 💵 💰 💳 💎 ⚖️ 🔧 🔨 🛠️ ⚙️ 🔩 🧲 " +
        "🧪 🔬 🔭 💊 💉 🧬 🔑 🗝️ 🚪 🛋️ 🛏️ 🧸 ✉️ 📦 📫 📝 📁 📅 📌 📎 ✂️ 🔒 🔓 📚 📖 🔖 🏷️ 📈 📉 📊 🗑️ 🔔 🔕 📣 🕶️ 👓 " +
        "👑 🎩 👟 👠 👕 👖 💼 🎒 ☂️",
    ),
  },
  {
    name: "Symbols",
    icon: "❤️",
    emoji: list(
      "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💯 💢 💥 💫 💦 💨 💬 💭 💤 ✅ ❌ ❓ ❗ ‼️ ⁉️ ⚠️ 🚫 ⭕ " +
        "🔥 ✨ ⭐ 🌟 ⚡ 🎵 🎶 ➕ ➖ ✔️ ☑️ 🆗 🆒 🆕 🆙 🔝 ♻️ ⬆️ ⬇️ ➡️ ⬅️ 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ 🏁 🚩 🏳️ 🏴 🏳️‍🌈 🏴‍☠️",
    ),
  },
];

/** Every emoji the picker offers: the only ones a reaction may be. */
export const EMOJI: ReadonlySet<string> = new Set(CATEGORIES.flatMap((c) => c.emoji));

/** How many recently used emoji the picker remembers (per browser). */
export const RECENT_MAX = 24;
const RECENT_KEY = "chat.recentEmoji";

/** Recently picked emoji, newest first. Empty when storage is unavailable (private mode, blocked). */
export function recentEmoji(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(saved) ? saved.filter((e): e is string => typeof e === "string" && EMOJI.has(e)).slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

/** Remember `emoji` as the most recently used. */
export function rememberEmoji(emoji: string): void {
  if (!EMOJI.has(emoji)) return;
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([emoji, ...recentEmoji().filter((e) => e !== emoji)].slice(0, RECENT_MAX)));
  } catch {
    // storage unavailable: the picker just has no "Recent" row
  }
}
