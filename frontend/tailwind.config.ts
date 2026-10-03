import type { Config } from 'tailwindcss'

/**
 * "Kitchen Garden" palette (UI.md) mapped to Tailwind theme tokens.
 * Use the semantic names below in classes: bg-oat, bg-cream, border-linen,
 * text-ink, text-thyme, bg-basil, bg-basil-tint, bg-sage, bg-squash,
 * bg-tomato, bg-blueberry, …
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        oat: '#F6F1E7', // page background
        cream: '#FFFDF8', // cards, right panel
        linen: '#E4DCCB', // dividers, card borders
        ink: '#1F2A24', // Charcoal Herb: primary text
        thyme: '#6B7368', // labels, secondary text
        basil: { DEFAULT: '#2F5D46', tint: '#DCE8DA' }, // nav, buttons, active tab / hover, selected
        sage: '#8FB38A', // severity low
        squash: '#E8A93B', // severity medium
        tomato: '#D9573B', // severity high
        blueberry: '#2E4A7D', // chart bars/line
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['Fraunces', 'ui-serif', 'Georgia', 'serif'],
      },
      borderRadius: {
        card: '12px',
        btn: '8px',
      },
      boxShadow: {
        soft: '0 1px 2px rgb(31 42 36 / 0.04), 0 4px 16px rgb(31 42 36 / 0.06)',
      },
    },
  },
  plugins: [],
} satisfies Config
