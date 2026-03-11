import { useEffect } from 'react';

interface PageMeta {
  title: string;
  description: string;
  canonical?: string;
  ogTitle?: string;
  ogDescription?: string;
}

const BASE_URL = 'https://botmem.xyz';
const BRAND = 'Botmem';

function setMeta(name: string, content: string, attr = 'name') {
  let el = document.querySelector(`meta[${attr}="${name}"]`) as HTMLMetaElement | null;
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute(attr, name);
    document.head.appendChild(el);
  }
  el.content = content;
}

function setCanonical(href: string) {
  let el = document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;
  if (!el) {
    el = document.createElement('link');
    el.rel = 'canonical';
    document.head.appendChild(el);
  }
  el.href = href;
}

export function usePageMeta({ title, description, canonical, ogTitle, ogDescription }: PageMeta) {
  useEffect(() => {
    const prevTitle = document.title;

    document.title = title.includes(BRAND) ? title : `${title} | ${BRAND}`;
    setMeta('description', description);
    setCanonical(canonical ?? `${BASE_URL}${window.location.pathname}`);
    setMeta('og:title', ogTitle ?? title, 'property');
    setMeta('og:description', ogDescription ?? description, 'property');
    setMeta('og:url', canonical ?? `${BASE_URL}${window.location.pathname}`, 'property');
    setMeta('twitter:title', ogTitle ?? title, 'name');
    setMeta('twitter:description', ogDescription ?? description, 'name');

    return () => {
      document.title = prevTitle;
    };
  }, [title, description, canonical, ogTitle, ogDescription]);
}
