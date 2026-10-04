import type { Config } from 'tailwindcss'

/**
 * MVP theme (UI.md): black and white only, Times New Roman. Styling comes
 * later. The token names are kept from the earlier palette so components
 * didn't change; every color token is now black or white. The one exception
 * is waste going down (good, green) or up (bad, red) on the summary cards.
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
        good: '#15803D', // waste down (5.0:1 on white)
        bad: '#B91C1C', // waste up (6.5:1 on white)
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
