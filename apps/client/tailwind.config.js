/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      screens: {
        // Phones in either orientation: narrow (portrait) or short (landscape)
        compact: { raw: "(max-width: 767px), (max-height: 520px)" },
        // Touch screens: no mouse hints
        touch: { raw: "(pointer: coarse)" },
      },
    },
  },
  plugins: [],
};
