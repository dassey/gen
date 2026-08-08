import { defineConfig } from 'vite'

// Served from https://<user>.github.io/gen/ by default. Override with
// BASE_PATH=/ when serving from a domain root or a different sub-path.
export default defineConfig({
  base: process.env.BASE_PATH || '/gen/',
})
