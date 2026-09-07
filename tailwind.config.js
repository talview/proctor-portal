/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: '#f8fafc',
        surface: '#ffffff',
        surface2: '#f1f5f9',
        surface3: '#e2e8f0',
        border: '#cbd5e1',
        border2: '#94a3b8',
        accent: '#1d4ed8',
        accent5: '#7c3aed',
        text: '#0f172a',
        text2: '#475569',
        text3: '#64748b',
        success: '#15803d',
        warning: '#b45309',
        danger: '#b91c1c',
        info: '#0369a1',
      },
      fontFamily: {
        sans: ['DM Sans', 'sans-serif'],
        mono: ['DM Mono', 'monospace'],
      },
    },
  },
  plugins: [],
}
