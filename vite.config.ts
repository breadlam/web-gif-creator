/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  // Relative asset paths so the build works from any GitHub Pages subpath.
  base: './',
  plugins: [svelte()],
  // @ffmpeg/ffmpeg spawns its own module worker; pre-bundling breaks the worker URL.
  optimizeDeps: { exclude: ['@ffmpeg/ffmpeg'] },
  worker: { format: 'es' },
  build: { target: 'es2022' },
  test: { include: ['tests/unit/**/*.test.ts'] },
});
