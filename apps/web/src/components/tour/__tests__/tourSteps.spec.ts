import { describe, it, expect } from 'vitest';
import { tourSteps } from '../tourSteps';

const VALID_ROUTES = ['/dashboard', '/connectors', '/people', '/me', '/settings'];

describe('tourSteps', () => {
  it('has exactly 8 steps', () => {
    expect(tourSteps).toHaveLength(8);
  });

  it('all steps have non-empty target selectors', () => {
    for (const step of tourSteps) {
      expect(step.target).toBeTruthy();
      expect(step.target.length).toBeGreaterThan(0);
    }
  });

  it('all steps have non-empty titles and descriptions', () => {
    for (const step of tourSteps) {
      expect(step.title).toBeTruthy();
      expect(step.description).toBeTruthy();
    }
  });

  it('all step pages are valid routes', () => {
    for (const step of tourSteps) {
      expect(VALID_ROUTES).toContain(step.page);
    }
  });

  it('starts on /dashboard (step 0)', () => {
    expect(tourSteps[0].page).toBe('/dashboard');
  });

  it('step 0 targets the search bar', () => {
    expect(tourSteps[0].target).toBe('[data-tour="search-bar"]');
  });

  it('has an interactive search step with searchExample', () => {
    const interactiveSteps = tourSteps.filter((s) => s.interactable);
    expect(interactiveSteps.length).toBeGreaterThanOrEqual(1);

    for (const step of interactiveSteps) {
      expect(step.searchExample).toBeTruthy();
    }
  });

  it('ends on /dashboard with the search bar (last step)', () => {
    const lastStep = tourSteps[tourSteps.length - 1];
    expect(lastStep.page).toBe('/dashboard');
    expect(lastStep.target).toBe('[data-tour="search-bar"]');
    expect(lastStep.title).toContain('Ready');
  });

  it('covers all major pages', () => {
    const pages = new Set(tourSteps.map((s) => s.page));
    expect(pages).toContain('/dashboard');
    expect(pages).toContain('/connectors');
    expect(pages).toContain('/people');
    expect(pages).toContain('/me');
  });

  it('all targets use data-tour attribute selectors', () => {
    for (const step of tourSteps) {
      expect(step.target).toMatch(/^\[data-tour="[^"]+"\]$/);
    }
  });
});
