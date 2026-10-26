import { defineConfig, minimal2023Preset } from '@vite-pwa/assets-generator/config';

// Иконка уже залита фоном до краёв, поэтому отступы не нужны:
// иначе на домашнем экране айфона вокруг неё появится белая рамка.
export default defineConfig({
  preset: {
    ...minimal2023Preset,
    transparent: { ...minimal2023Preset.transparent, padding: 0 },
    maskable: { ...minimal2023Preset.maskable, padding: 0 },
    apple: { ...minimal2023Preset.apple, padding: 0 },
  },
  images: ['public/icon.svg'],
});
