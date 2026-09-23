/** @type {import('tailwindcss').Config} */
// Every color resolves through a CSS variable (defined for :root and .dark in
// index.css) instead of a hardcoded hex -- same class names everywhere in the
// app (bg-surface, text-text2, border-border, ...), but the variable underneath
// flips with the theme. `rgb(var(--x) / <alpha-value>)` is what preserves
// existing opacity-modifier usage (bg-accent/25, text-warning/15, etc. are
// already used throughout the app) -- Tailwind substitutes <alpha-value> itself.
function themeColor(name) {
  return `rgb(var(--color-${name}) / <alpha-value>)`;
}

export default {
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: themeColor('bg'),
        surface: themeColor('surface'),
        surface2: themeColor('surface2'),
        surface3: themeColor('surface3'),
        border: themeColor('border'),
        border2: themeColor('border2'),
        accent: themeColor('accent'),
        accent5: themeColor('accent5'),
        text: themeColor('text'),
        text2: themeColor('text2'),
        text3: themeColor('text3'),
        success: themeColor('success'),
        warning: themeColor('warning'),
        danger: themeColor('danger'),
        info: themeColor('info'),
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        display: ['Lexend', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'monospace'],
      },
    },
  },
  plugins: [],
}
