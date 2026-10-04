import type { Config } from 'tailwindcss'

/**
 * Theme: black and white only, Helvetica (2026-10-04). The token names are kept from the earlier palette so components
 * didn't change; every color token is now black or white.
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        oat: '#FFFFFF', // page background
        cream: '#FFFFFF', // cards, panels, text on black
        linen: '#000000', // borders and dividers
        ink: '#000000', // text
        thyme: '#000000', // secondary text
        basil: { DEFAULT: '#000000', tint: '#FFFFFF' }, // nav, buttons, selected / hover
      },
      fontFamily: {
        sans: ['Helvetica', '"Helvetica Neue"', 'Arial', 'sans-serif'],
        display: ['Helvetica', '"Helvetica Neue"', 'Arial', 'sans-serif'],
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
