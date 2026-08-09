/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: [
          'Inter',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      colors: {
        // Restrained brand accent. Red/amber/green are deliberately NOT extended
        // here: they belong to RAG semantics and are used only for those.
        accent: {
          50: '#eef4fd',
          100: '#d7e6fa',
          200: '#b1cdf5',
          300: '#86b6ef',
          400: '#5598e7',
          500: '#2a78d6',
          600: '#256abf',
          700: '#1c5cab',
          800: '#184f95',
          900: '#0d366b',
        },
      },
    },
  },
  plugins: [],
};
