import daisyui from 'daisyui';

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      animation: {
        'fade-up-for-bottombar.5s': 'fadeUpForBottomBar 0.5s ease-out forwards',
      },
      keyframes: {
        fadeUpForBottomBar: {
          '0%': {
            opacity: '0',
            transform: 'translateY(68px)', // 从下方20px开始
          },
          '100%': {
            opacity: '1',
            transform: 'translateY(0)', // 位置恢复到原位
          },
        },
      },
    },
  },
  darkMode: ['selector', '[data-theme="dark"]'],
  corePlugins: {
    preflight: false,
  },
  plugins: [
    daisyui,
  ],
  daisyui: {
    themes: [
      {
        light: {
          ...require("daisyui/src/theming/themes")["light"],
          primary: '#2d343f',
        }
      },
      {
        dark: {
          ...require("daisyui/src/theming/themes")["dark"],
          primary: '#2c323b',
        }
      }], // https://daisyui.com/docs/themes/
  }
}
