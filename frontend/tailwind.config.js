/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-ui)'],
        mono: ['var(--font-mono)'],
      },
      colors: {
        // Slate-blue primary scale (Direction C accent).
        // Tailwind classes can't pick up CSS-var switching on theme toggle,
        // so this is a fixed scale centered on the dark-theme accent.
        // Prefer semantic CSS vars (e.g. var(--accent-blue)) over these
        // classes for the accent colour in component styles.
        primary: {
          50:  '#eef1f6',
          100: '#d7dee9',
          200: '#bfcada',
          300: '#a8b7cc',
          400: '#96a8c2',
          500: '#8aa0c7',
          600: '#7389b3',
          700: '#5a74a8',
          800: '#42588a',
          900: '#2f4069',
        },
        surface: {
          base: 'rgb(var(--bg-base-rgb) / <alpha-value>)',
          DEFAULT: 'rgb(var(--bg-surface-rgb) / <alpha-value>)',
          raised: 'rgb(var(--bg-surface-raised-rgb) / <alpha-value>)',
          elevated: 'rgb(var(--bg-elevated-rgb) / <alpha-value>)',
          overlay: 'rgb(var(--bg-overlay-rgb) / <alpha-value>)',
          hover: 'rgb(var(--bg-hover-rgb) / <alpha-value>)',
        },
        content: {
          DEFAULT: 'rgb(var(--text-primary-rgb) / <alpha-value>)',
          secondary: 'rgb(var(--text-secondary-rgb) / <alpha-value>)',
          'secondary-bright': 'rgb(var(--text-secondary-bright-rgb) / <alpha-value>)',
          tertiary: 'rgb(var(--text-tertiary-rgb) / <alpha-value>)',
          link: 'rgb(var(--text-link-rgb) / <alpha-value>)',
        },
        border: {
          DEFAULT: 'rgb(var(--border-default-rgb) / <alpha-value>)',
          muted: 'rgb(var(--border-muted-rgb) / <alpha-value>)',
          strong: 'rgb(var(--border-strong-rgb) / <alpha-value>)',
        },
        accent: {
          blue: 'rgb(var(--accent-blue-rgb) / <alpha-value>)',
          green: 'rgb(var(--accent-green-rgb) / <alpha-value>)',
          red: 'rgb(var(--accent-red-rgb) / <alpha-value>)',
          yellow: 'rgb(var(--accent-yellow-rgb) / <alpha-value>)',
          purple: 'rgb(var(--accent-purple-rgb) / <alpha-value>)',
          orange: 'rgb(var(--accent-orange-rgb) / <alpha-value>)',
        },
      },
    },
  },
  plugins: [],
}
