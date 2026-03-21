import DefaultTheme from 'vitepress/theme';
import type { Theme } from 'vitepress';
import { useRouter } from 'vitepress';
import { onMounted, watch } from 'vue';
import './custom.css';

export default {
  extends: DefaultTheme,
  setup() {
    if (typeof window === 'undefined') return;

    const router = useRouter();
    let posthog: typeof import('posthog-js').default | null = null;

    onMounted(async () => {
      const key = import.meta.env.VITE_POSTHOG_API_KEY;
      const host = import.meta.env.VITE_POSTHOG_HOST || 'https://t.botmem.xyz';
      if (!key) return;

      try {
        const { default: ph } = await import('posthog-js');
        ph.init(key, {
          api_host: host,
          capture_pageview: false,
          autocapture: true,
          capture_pageleave: true,
          persistence: 'localStorage+cookie',
        });
        posthog = ph;
        posthog.capture('$pageview', { path: router.route.path });
      } catch {
        // PostHog proxy unreachable or blocked — silently skip
      }
    });

    watch(
      () => router.route.path,
      (path) => {
        posthog?.capture('$pageview', { path });
      },
    );
  },
} satisfies Theme;
