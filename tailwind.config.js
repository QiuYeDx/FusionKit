import daisyui from 'daisyui';

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {},
  },
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
