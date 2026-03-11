import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface TourState {
  active: boolean;
  currentStep: number;
  demoMode: boolean;
  tourCompleted: boolean;
  startTour: (demoMode?: boolean) => void;
  nextStep: () => void;
  prevStep: () => void;
  skipTour: () => void;
  completeTour: () => void;
  resetTour: () => void;
}

export const useTourStore = create<TourState>()(
  persist(
    (set) => ({
      active: false,
      currentStep: 0,
      demoMode: false,
      tourCompleted: false,
      startTour: (demoMode = false) => set({ active: true, currentStep: 0, demoMode }),
      nextStep: () => set((s) => ({ currentStep: s.currentStep + 1 })),
      prevStep: () => set((s) => ({ currentStep: Math.max(0, s.currentStep - 1) })),
      skipTour: () => set({ active: false, currentStep: 0 }),
      completeTour: () => set({ active: false, currentStep: 0, tourCompleted: true }),
      resetTour: () => set({ active: false, currentStep: 0, tourCompleted: false }),
    }),
    {
      name: 'botmem-tour',
      partialize: (state) => ({ tourCompleted: state.tourCompleted, demoMode: state.demoMode }),
    },
  ),
);
