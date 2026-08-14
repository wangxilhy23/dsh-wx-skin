import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    server: {
      deps: {
        inline: [/@deepseek-ai\//],
      },
    },
  },
})
