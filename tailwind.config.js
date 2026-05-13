/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Inter"', 'system-ui', 'sans-serif'],
        serif: ['"Instrument Serif"', 'Georgia', 'serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      colors: {
        ink: {
          50: '#f6f5f1',
          100: '#ece9df',
          200: '#d6cfbc',
          300: '#b3a888',
          500: '#6b6450',
          700: '#3a352a',
          900: '#1a1813',
        },
        amber: {
          50: '#fff8eb',
          400: '#f4b740',
          500: '#e89a18',
          600: '#c97a08',
        },
      },
      animation: {
        'flash-in': 'flashIn 1.8s ease-out',
        'soft-pulse': 'softPulse 2s ease-in-out infinite',
      },
      keyframes: {
        flashIn: {
          '0%': { backgroundColor: 'rgba(244, 183, 64, 0.35)', transform: 'translateY(-4px)' },
          '100%': { backgroundColor: 'transparent', transform: 'translateY(0)' },
        },
        softPulse: {
          '0%, 100%': { opacity: '0.55' },
          '50%': { opacity: '1' },
        },
      },
    },
  },
  plugins: [],
};
