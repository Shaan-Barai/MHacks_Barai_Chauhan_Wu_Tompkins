import type { Config } from 'tailwindcss'

/**
 * MVP monochrome theme (UI.md): black, white, and greys only, Times New Roman.
 * The semantic token names are kept from the earlier palette so components
 * don't change: bg-oat, bg-cream, border-linen, text-ink, text-thyme,
 * bg-basil, bg-basil-tint, bg-sage, bg-squash, bg-tomato, bg-blueberry, …
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        oat: '#FFFFFF', // page background
        cream: '#FFFFFF', // cards, right panel
        linen: '#D4D4D4', // dividers, card borders
        ink: '#000000', // primary text
        thyme: '#555555', // labels, secondary text
        basil: { DEFAULT: '#000000', tint: '#EBEBEB' }, // nav, buttons, active tab / hover, selected
        sage: '#FFFFFF', // severity low (dot gets a black outline)
        squash: '#808080', // severity medium; "missing menu" marker
        tomato: '#000000', // severity high; waste-went-up and error text
        blueberry: '#000000', // chart bars/line
      },
      fontFamily: {
        sans: ['"Times New Roman"', 'Times', 'serif'],
        display: ['"Times New Roman"', 'Times', 'serif'],
      },
      borderRadius: {
        card: '4px',
        btn: '4px',
      },
      boxShadow: {
        soft: 'none',
      },
    },
  },
  plugins: [],
} satisfies Config
