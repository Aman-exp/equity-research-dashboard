import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // GitHub Pages serves from /<repo>/ unless a custom domain is used.
  // Overridden to '/' for local dev by Vite's mode handling.
  base: process.env.GITHUB_PAGES === 'true' ? '/equity-research-dashboard/' : '/',
})
